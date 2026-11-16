import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SectionTiming, SessionStep } from '../../api/participant'
import i18n from '../../i18n'
import PreTestPage from './PreTestPage'

const enterPage = vi.fn()
const finishPage = vi.fn()
vi.mock('../../hooks/participant', () => ({
  useEnterQuestionnaire: () => ({ mutateAsync: enterPage, isPending: false }),
  useFinishCK: () => ({ mutateAsync: finishPage, isPending: false }),
}))
vi.mock('../../lib/outbox', () => ({ enqueue: vi.fn() }))

const step: Extract<SessionStep, { kind: 'questionnaire' }> = {
  index: 5,
  completed: false,
  kind: 'questionnaire',
  questionnaire_id: 12,
  placement: 'pre_test',
  title: 'CK: Aufgabe 1',
  description: '',
  section: 'CK',
  section_key: 'ck_tasks',
  video_id: null,
  page: 4,
  page_count: 25,
  questions: [
    {
      id: 'ck_pre_01',
      type: 'debugging',
      text: 'Wo ist der Fehler?',
      min: 1,
      max: 12,
      allow_skip: true,
    },
  ],
}
const clock = (overrides: Partial<SectionTiming> = {}): SectionTiming => ({
  section_key: 'ck_tasks',
  deadline_ms: 520000,
  server_now_ms: 100000,
  finished: false,
  started_client_ts: 100000,
  ended_client_ts: null,
  ...overrides,
})
const onSubmit = vi.fn()
const onTimerFinished = vi.fn()
const noop = () => undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  localStorage.clear()
  onSubmit.mockReset().mockResolvedValue(true)
  onTimerFinished.mockReset()
  enterPage
    .mockReset()
    .mockImplementation((body) =>
      Promise.resolve({ visit_id: body.visit_id, section_timing: clock() }),
    )
  finishPage.mockReset().mockResolvedValue({
    current_step_index: 18,
    total_steps: 69,
    status: 'active',
    complete: false,
  })
})
afterEach(() => {
  vi.useRealTimers()
})

const view = async (pilot = true, page = step) => {
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <PreTestPage
        step={page}
        participantId="PILOT"
        pilot={pilot}
        submitting={false}
        onVisitReady={noop}
        onBusyChange={noop}
        finishRequested={false}
        onCloseFinish={noop}
        onTimerFinished={onTimerFinished}
        onSubmit={onSubmit}
      />,
    )
  })
  return result!
}

test.each([
  ['ck_tasks', 'CK: Aufgabe 1', 4],
  ['pck', 'Fachdidaktisches Wissen', 17],
  ['mesp', 'MESP: Aufgabe 6', 25],
])(
  'the %s counter explicitly covers the whole questionnaire sequence',
  async (section, title, page) => {
    await view(true, { ...step, section_key: section, title, page })
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.getByText(`Fragebogenseite ${page} von 25 insgesamt`)).toBeInTheDocument()
    expect(screen.queryByText(`Seite ${page} von 25`, { exact: true })).toBeNull()
  },
)

test('the English counter also identifies global questionnaire progress', async () => {
  await i18n.changeLanguage('en')
  try {
    await view()
    expect(screen.getByText('Questionnaire page 4 of 25 overall')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'CK: Aufgabe 1' })).toBeInTheDocument()
  } finally {
    await i18n.changeLanguage('de')
  }
})

test('explicit skip is left of Continue and saves only zero plus an empty explanation', async () => {
  await view()
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discard this draft' } })
  const skip = screen.getByRole('button', {
    name: 'Ich finde den Fehler nicht, Aufgabe überspringen',
  })
  const next = screen.getByRole('button', { name: 'Weiter' })
  expect(skip.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await act(async () => {
    fireEvent.click(skip)
  })
  expect(onSubmit).toHaveBeenCalledWith(
    { ck_pre_01: { lines: [0], explanation: '', skipped: true } },
    expect.any(Number),
    expect.any(String),
    expect.any(Number),
  )
  expect(finishPage).not.toHaveBeenCalled()
})

test('seven-minute expiry saves the current draft once and notifies before continuing', async () => {
  await view()
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'An incomplete thought' } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(420001)
  })
  expect(finishPage).toHaveBeenCalledTimes(1)
  expect(finishPage).toHaveBeenCalledWith(
    expect.objectContaining({
      expected_step_index: 5,
      reason: 'timer_expired',
      answers: { ck_pre_01: { lines: [3], explanation: 'An incomplete thought' } },
    }),
  )
  expect(onTimerFinished).toHaveBeenCalledTimes(1)
  expect(onSubmit).not.toHaveBeenCalled()
})

test('reload after the persisted deadline exits with the restored partial draft', async () => {
  enterPage.mockImplementation((body) =>
    Promise.resolve({ visit_id: body.visit_id, section_timing: clock({ deadline_ms: 99900 }) }),
  )
  localStorage.setItem(
    'a04.draft.PILOT:questionnaire:12',
    JSON.stringify({ ck_pre_01: { lines: [-1], explanation: 'unfinished' } }),
  )
  await view()
  expect(finishPage).toHaveBeenCalledTimes(1)
  expect(finishPage.mock.calls[0][0]).toMatchObject({
    reason: 'timer_expired',
    answers: { ck_pre_01: { lines: [-1], explanation: 'unfinished' } },
  })
})

test('deadline uses the server clock, and a completed attempt stays in review', async () => {
  enterPage.mockImplementation((body) =>
    Promise.resolve({
      visit_id: body.visit_id,
      section_timing: clock({ server_now_ms: 50000, deadline_ms: 55000 }),
    }),
  )
  const rendered = await view()
  expect(finishPage).not.toHaveBeenCalled()
  expect(screen.getByRole('timer')).toHaveTextContent('0:05')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5001)
  })
  expect(finishPage).toHaveBeenCalledTimes(1)
  rendered.unmount()
  finishPage.mockClear()
  enterPage.mockImplementation((body) =>
    Promise.resolve({
      visit_id: body.visit_id,
      section_timing: clock({ deadline_ms: 99900, finished: true }),
    }),
  )
  await view()
  expect(finishPage).not.toHaveBeenCalled()
  expect(
    screen.getByText('Ansicht nach Abschluss des zeitbegrenzten Abschnitts.'),
  ).toBeInTheDocument()
})

test('a failed expiry retries the same immutable request and keeps controls frozen', async () => {
  enterPage.mockImplementation((body) =>
    Promise.resolve({ visit_id: body.visit_id, section_timing: clock({ deadline_ms: 99900 }) }),
  )
  finishPage.mockRejectedValueOnce(new Error('offline'))
  await view()
  expect(screen.getByRole('textbox')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  const original = structuredClone(finishPage.mock.calls[0][0])
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
  })
  expect(finishPage).toHaveBeenCalledTimes(2)
  expect(finishPage.mock.calls[1][0]).toEqual(original)
  expect(onTimerFinished).toHaveBeenCalledTimes(1)
})

test('legacy studies retain supervisor-only expiry and have no participant skip button', async () => {
  await view(false)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(420001)
  })
  expect(finishPage).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /Aufgabe überspringen/ })).toBeNull()
  expect(
    screen.getByText('Die Zeit ist abgelaufen. Die Studienleitung beendet den Abschnitt.'),
  ).toBeInTheDocument()
})

test('expiry supersedes a failed in-flight supervisor request without losing the draft', async () => {
  let failSupervisor: (error: Error) => void = () => undefined
  finishPage.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        failSupervisor = reject
      }),
  )
  localStorage.setItem(
    'a04.draft.PILOT:questionnaire:12',
    JSON.stringify({ ck_pre_01: { lines: [-1], explanation: 'draft' } }),
  )
  await act(async () => {
    render(
      <PreTestPage
        step={step}
        participantId="PILOT"
        pilot
        submitting={false}
        onVisitReady={noop}
        onBusyChange={noop}
        finishRequested
        onCloseFinish={noop}
        onTimerFinished={onTimerFinished}
        onSubmit={onSubmit}
      />,
    )
  })
  fireEvent.click(screen.getByRole('button', { name: 'Speichern und zu PCK' }))
  expect(finishPage).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(420001)
  })
  expect(finishPage).toHaveBeenCalledTimes(1)
  await act(async () => {
    failSupervisor(new Error('invalid line'))
  })
  expect(finishPage).toHaveBeenCalledTimes(2)
  const [manual, automatic] = finishPage.mock.calls.map(([body]) => body)
  expect(manual.reason).toBe('supervisor')
  expect(automatic.reason).toBe('timer_expired')
  expect(automatic.request_id).not.toBe(manual.request_id)
  expect(automatic.answers).toEqual(manual.answers)
})

test('a normal save rejected at the deadline hands the unchanged current draft to timer finish', async () => {
  let rejectLateSave: () => void = () => undefined
  const acknowledgement = new Promise<void>((resolve) => {
    rejectLateSave = resolve
  })
  function WaitingSubmission() {
    const [submitting, setSubmitting] = useState(false)
    return (
      <PreTestPage
        step={step}
        participantId="PILOT"
        pilot
        submitting={submitting}
        onVisitReady={noop}
        onBusyChange={noop}
        finishRequested={false}
        onCloseFinish={noop}
        onTimerFinished={onTimerFinished}
        onSubmit={async () => {
          setSubmitting(true)
          await acknowledgement
          setSubmitting(false)
          return false
        }}
      />
    )
  }
  await act(async () => {
    render(<WaitingSubmission />)
  })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'saved at the boundary' } })
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(420001)
  })
  expect(finishPage).not.toHaveBeenCalled()
  await act(async () => {
    rejectLateSave()
  })
  expect(finishPage).toHaveBeenCalledTimes(1)
  expect(finishPage.mock.calls[0][0]).toMatchObject({
    reason: 'timer_expired',
    expected_step_index: step.index,
    answers: { ck_pre_01: { lines: [3], explanation: 'saved at the boundary' } },
  })
})
