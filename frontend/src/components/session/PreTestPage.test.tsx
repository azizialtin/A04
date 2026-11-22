import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import firstPilot from '../../../../backend/app/data/pretest_pilot20261116.json'
import revisedPilot from '../../../../backend/app/data/pretest_pilot20261120.json'
import type { SectionTiming, SessionStep } from '../../api/participant'
import i18n from '../../i18n'
import type { Answers, Question } from '../../lib/questionnaire'
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

// Keep the production IDs and dependencies while using short labels to focus on
// navigation, validation and persistence rather than the authored wording.
const yesNo = (id: string): Question => ({
  id,
  text: id,
  type: 'multiple_choice',
  options: [
    { value: 1, label: 'ja' },
    { value: 0, label: 'nein' },
  ],
})
const demographicQuestions: Question[] = [
  { id: 'sex', text: 'Geschlecht', type: 'multiple_choice', options: ['weiblich', 'männlich'] },
  { id: 'age', text: 'Alter', type: 'number', min: 16, max: 99 },
  {
    id: 'participant_group',
    text: 'Rolle',
    type: 'multiple_choice',
    options: [
      { value: 1, label: 'Lehramtsstudierende:r' },
      { value: 2, label: 'Lehrkraft' },
      { value: 3, label: 'Sonstiges' },
    ],
  },
  { id: 'st_degree', text: 'Abschluss', type: 'free_text' },
  yesNo('st_enrollment'),
  {
    id: 'st_subject',
    text: 'Studiengang',
    type: 'free_text',
    show_if: { question: 'st_enrollment', equals: 1 },
  },
  {
    id: 'st_semester',
    text: 'Fachsemester',
    type: 'number',
    min: 1,
    max: 30,
    show_if: { question: 'st_enrollment', equals: 1 },
  },
  {
    id: 'st_schulform',
    text: 'Schulform',
    type: 'multiple_choice',
    options: [
      { value: 4, label: 'Gymnasium' },
      { value: 7, label: 'andere' },
    ],
  },
  {
    id: 'dupl1_st_schulform',
    text: 'Welche andere Schulform?',
    type: 'free_text',
    show_if: { question: 'st_schulform', equals: 7 },
  },
  { id: 'st_fach1', text: 'Unterrichtsfach 1', type: 'free_text' },
  { id: 'st_fach2', text: 'Unterrichtsfach 2', type: 'free_text', required: false },
  { id: 'st_fach3', text: 'Unterrichtsfach 3', type: 'free_text', required: false },
  { id: 'st_schulpraktikum', text: 'Praktikumstage', type: 'number', min: 0, max: 999 },
  {
    id: 'st_unterricht',
    text: 'Selbst gehaltene Unterrichtsstunden',
    type: 'number',
    min: 0,
    max: 9999,
    show_if: { question: 'participant_group', equals: 1 },
  },
  ...(['teach_inf', 'teach_prog', 'java'] as const).flatMap((prefix): Question[] => [
    yesNo(`${prefix}_ex`),
    {
      id: prefix === 'java' ? 'java_years' : `${prefix}_year`,
      text: `${prefix} Jahre`,
      type: 'number',
      min: 0,
      max: 50,
      show_if: { question: `${prefix}_ex`, equals: 1 },
    },
  ]),
  { id: 'teach_class', text: 'Jahrgangsstufen', type: 'free_text', required: false },
]
const demographicsStep: typeof step = {
  ...step,
  questionnaire_id: 21,
  title: 'Angaben zur Person',
  description: 'Bitte machen Sie einige Angaben zu sich und zu Ihrer Ausbildung.',
  section: 'Demographics',
  section_key: 'demographics',
  page: 1,
  questions: demographicQuestions,
}
const demographicsDraftKey = 'a04.draft.PILOT:questionnaire:21'
const firstPageAnswers: Answers = {
  sex: 'weiblich',
  age: 24,
  participant_group: 1,
  st_degree: 'Bachelor',
  st_enrollment: 0,
  st_schulform: 4,
}
const secondPageAnswers: Answers = {
  st_fach1: 'Informatik',
  st_schulpraktikum: 20,
  st_unterricht: 4,
  teach_inf_ex: 0,
  teach_prog_ex: 0,
  java_ex: 0,
}
const demographicField = (id: string) => {
  const question = demographicQuestions.find((item) => item.id === id)!
  return screen.getByRole('group', {
    name: `${question.text}${question.required === false ? '' : ' *'}`,
  })
}
const enterDemographic = (id: string, value: string | number) => {
  const question = demographicQuestions.find((item) => item.id === id)!
  const field = within(demographicField(id))
  if (question.type === 'multiple_choice') {
    const option = question.options!.find((item) =>
      typeof item === 'string' ? item === value : item.value === value,
    )!
    fireEvent.click(
      field.getByRole('radio', { name: typeof option === 'string' ? option : option.label }),
    )
  } else {
    fireEvent.change(field.getByRole(question.type === 'number' ? 'spinbutton' : 'textbox'), {
      target: { value: String(value) },
    })
  }
}
const completeDemographics = (answers: Answers) => {
  for (const [id, answer] of Object.entries(answers))
    enterDemographic(id, answer as string | number)
}

test('demographics validates the active page and shows enrollment and school follow-ups in place', async () => {
  await view(true, demographicsStep)
  const next = screen.getByRole('button', { name: 'Weiter' })
  expect(screen.getByText('Seite 1 von 2: Persönliche Angaben und Ausbildung')).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Unterrichtsfach 1 *' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Studiengang *' })).toBeNull()
  expect(next).toBeDisabled()
  completeDemographics(firstPageAnswers)
  expect(next).toBeEnabled()

  enterDemographic('st_enrollment', 1)
  expect(next).toBeDisabled()
  enterDemographic('st_subject', 'Lehramt Informatik')
  enterDemographic('st_semester', 0)
  expect(next).toBeDisabled()
  enterDemographic('st_semester', 3)
  expect(next).toBeEnabled()
  enterDemographic('st_schulform', 7)
  expect(next).toBeDisabled()
  enterDemographic('dupl1_st_schulform', 'Gesamtschule')
  expect(next).toBeEnabled()
  fireEvent.click(next)

  expect(screen.getByText('Seite 2 von 2: Unterricht und Erfahrung')).toBeInTheDocument()
  expect(demographicField('st_unterricht')).toBeInTheDocument()
  expect(onSubmit).not.toHaveBeenCalled()
  expect(enterPage).toHaveBeenCalledTimes(1)
  expect(JSON.parse(localStorage.getItem(demographicsDraftKey)!)).toMatchObject({
    ...firstPageAnswers,
    st_enrollment: 1,
    st_subject: 'Lehramt Informatik',
    st_semester: 3,
    st_schulform: 7,
    dupl1_st_schulform: 'Gesamtschule',
  })
})

test('demographics keeps both pages together and validates each experience follow-up before one save', async () => {
  await view(true, demographicsStep)
  completeDemographics(firstPageAnswers)
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  completeDemographics(secondPageAnswers)
  const next = screen.getByRole('button', { name: 'Weiter' })
  expect(next).toBeEnabled()
  for (const [trigger, years] of [
    ['teach_inf_ex', 'teach_inf_year'],
    ['teach_prog_ex', 'teach_prog_year'],
    ['java_ex', 'java_years'],
  ]) {
    enterDemographic(trigger, 1)
    expect(next).toBeDisabled()
    enterDemographic(years, 2)
    expect(next).toBeEnabled()
    enterDemographic(trigger, 0)
    expect(document.querySelector(`[data-aoi="question.${years}"]`)).toBeNull()
    expect(next).toBeEnabled()
  }

  fireEvent.click(screen.getByRole('button', { name: 'Zurück' }))
  expect(within(demographicField('age')).getByRole('spinbutton')).toHaveValue(24)
  enterDemographic('participant_group', 2)
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(screen.queryByRole('group', { name: 'Selbst gehaltene Unterrichtsstunden *' })).toBeNull()
  expect(within(demographicField('st_fach1')).getByRole('textbox')).toHaveValue('Informatik')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  })
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ ...firstPageAnswers, ...secondPageAnswers, participant_group: 2 }),
    expect.any(Number),
    expect.any(String),
    expect.any(Number),
  )
  expect(localStorage.getItem(demographicsDraftKey)).toBeNull()
  expect(finishPage).not.toHaveBeenCalled()
})

test('demographics restores answers from both pages after a reload and preserves a rejected save', async () => {
  const rendered = await view(false, demographicsStep)
  completeDemographics(firstPageAnswers)
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  enterDemographic('st_fach1', 'Mathematik')
  enterDemographic('teach_class', '8–10')
  rendered.unmount()
  await view(false, demographicsStep)
  expect(within(demographicField('st_degree')).getByRole('textbox')).toHaveValue('Bachelor')
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(within(demographicField('st_fach1')).getByRole('textbox')).toHaveValue('Mathematik')
  expect(within(demographicField('teach_class')).getByRole('textbox')).toHaveValue('8–10')
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  completeDemographics(secondPageAnswers)
  onSubmit.mockResolvedValueOnce(false)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  })
  expect(JSON.parse(localStorage.getItem(demographicsDraftKey)!)).toMatchObject({
    ...firstPageAnswers,
    ...secondPageAnswers,
    teach_class: '8–10',
  })
  expect(screen.getByText('Seite 2 von 2: Unterricht und Erfahrung')).toBeInTheDocument()
})

test('changing the role on page one makes the lesson count required only for student teachers', async () => {
  await view(true, demographicsStep)
  completeDemographics({ ...firstPageAnswers, participant_group: 2 })
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  const teacherAnswers = { ...secondPageAnswers }
  delete teacherAnswers.st_unterricht
  completeDemographics(teacherAnswers)
  expect(screen.queryByRole('group', { name: 'Selbst gehaltene Unterrichtsstunden *' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Zurück' }))
  enterDemographic('participant_group', 1)
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(within(demographicField('st_unterricht')).getByRole('spinbutton')).toHaveValue(null)
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  enterDemographic('st_unterricht', 0)
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled()
  expect(onSubmit).not.toHaveBeenCalled()
})

test('custom demographics retain every question in the ordinary form', async () => {
  await view(true, {
    ...demographicsStep,
    questions: [
      ...demographicQuestions,
      { id: 'additional_background', type: 'free_text', text: 'Zusätzliche Angaben' },
    ],
  })
  expect(screen.queryByText('Seite 1 von 2: Persönliche Angaben und Ausbildung')).toBeNull()
  expect(demographicField('sex')).toBeInTheDocument()
  expect(demographicField('st_fach1')).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Zusätzliche Angaben *' })).toBeInTheDocument()
})

test('demographics page labels and local navigation follow the selected interface language', async () => {
  await i18n.changeLanguage('en')
  try {
    await view(true, demographicsStep)
    expect(screen.getByRole('heading', { name: /Page 1 of 2:/ })).toBeInTheDocument()
    completeDemographics(firstPageAnswers)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: /Page 2 of 2:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
  } finally {
    await i18n.changeLanguage('de')
  }
})

type SourcePage = { source_task: number; title: string; description: string; questions: Question[] }
const revisedPck = revisedPilot.pck_pages as unknown as SourcePage[]
const firstPck = firstPilot.pck_pages as unknown as SourcePage[]

const pckStep = (page: SourcePage, number: number, pageCount: number) => ({
  ...step,
  title: page.title,
  description: page.description,
  questions: page.questions,
  section: 'PCK-Pretest',
  section_key: 'pck',
  questionnaire_id: 100 + number,
  page: 16 + number,
  page_count: pageCount,
})

const codeOf = (description: string) =>
  description.match(/```java\n([\s\S]*?)\n```/)?.[1].split('\n') ?? []

test.each(revisedPck.map((page, index) => ({ ...page, number: index + 1 })))(
  'revised PCK page $number puts one item group under its task heading, across the page',
  async ({ number, ...page }) => {
    const { container } = await view(true, pckStep(page, number, 32))
    const task = { 1: 1, 3: 2, 5: 3 }[page.source_task]
    expect(
      screen.getByRole('heading', { level: 2, name: `Fachdidaktisches Wissen - Aufgabe ${task}` }),
    ).toBeInTheDocument()
    expect(screen.getByText(`Fragebogenseite ${16 + number} von 32 insgesamt`)).toBeInTheDocument()
    const root = container.querySelector('.pretest-page')!
    expect(root).toHaveClass('pretest-page--pilot', 'pretest-page--pck-item')
    // Its own class: the three-column rules of the first pilot must not reach it.
    expect(root).not.toHaveClass('pretest-page--pck')

    // The situation and its code stay above; the item group is in plain flow below.
    const stimulus = container.querySelector('[data-aoi="instructions"] .study-stimulus')!
    const code = codeOf(page.description)
    expect(stimulus.classList.contains('study-stimulus--with-code')).toBe(code.length > 0)
    expect(
      Array.from(stimulus.querySelectorAll('.code__line')).map((line) =>
        line.textContent!.replace(/\n$/, ''),
      ),
    ).toEqual(code)
    expect(stimulus.querySelectorAll('.study-stimulus__quotation')).toHaveLength(1)
    expect(container.querySelector('.qlist--columns, .question-column')).toBeNull()
    expect(
      Array.from(container.querySelectorAll('.qlist [data-aoi]'))
        .map((element) => element.getAttribute('data-aoi')!)
        .filter((id) => /^question\.[^.]+$/.test(id)),
    ).toEqual(page.questions.map((question) => `question.${question.id}`))
    expect(stimulus.compareDocumentPosition(container.querySelector('.qlist')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    const next = screen.getByRole('button', { name: 'Weiter' })
    expect(next.closest('footer')).toHaveClass('questionnaire-footer')
    expect(next).toBeDisabled()

    const expected: Answers = {}
    const rated = page.questions.filter((question) => question.matrix)
    if (rated.length) {
      // Six labelled columns, named once in the table head rather than in a legend.
      const labels = (rated[0].options as { label: string }[]).map((option) => option.label)
      expect(labels).toHaveLength(6)
      expect(
        Array.from(container.querySelectorAll('thead th:not(:first-child)')).map(
          (heading) => heading.textContent,
        ),
      ).toEqual(labels.map((label, index) => `${index + 1}${label}`))
      expect(container.querySelector('.matrix__legend')).toBeNull()
      expect(container.querySelector('caption')).toHaveTextContent('Antwortmöglichkeiten')
      expect(container.querySelectorAll('.matrix')).toHaveLength(1)
      expect(
        screen.getByText(`Noch ${rated.length} von ${rated.length} Fragen offen`),
      ).toBeVisible()
    }
    for (const [index, question] of page.questions.entries()) {
      const field = container.querySelector<HTMLElement>(`[data-aoi="question.${question.id}"]`)!
      if (question.matrix) {
        const radios = within(field).getAllByRole('radio')
        expect(radios).toHaveLength(6)
        fireEvent.click(radios[(index + 5) % 6])
        expected[question.id] = ((index + 5) % 6) + 1
      } else if (question.type === 'free_text') {
        fireEvent.change(within(field).getByRole('textbox'), { target: { value: 'Begründung' } })
        expected[question.id] = 'Begründung'
      } else if (question.type === 'multi_select') {
        const boxes = within(field).getAllByRole('checkbox')
        fireEvent.click(boxes[1])
        fireEvent.click(boxes[3])
        expect(boxes[0]).toBeDisabled()
        expected[question.id] = [2, 4]
      } else if (question.type === 'ranking') {
        expect(
          within(field)
            .getAllByRole('listitem')
            .map((item) => item.textContent),
        ).toEqual(
          (question.options as { label: string }[]).map(
            (option, position) => `${position + 1}${option.label}↑↓`,
          ),
        )
        fireEvent.click(within(field).getAllByRole('button', { name: /Nach unten/ })[0])
        expected[question.id] = ['step_2', 'step_1', 'step_3', 'step_4']
      }
    }
    expect(next).toBeEnabled()
    await act(async () => {
      fireEvent.click(next)
    })
    expect(onSubmit).toHaveBeenCalledWith(expected, expect.any(Number), expect.any(String), 100000)
  },
)

test('revised PCK ratings name every point in the column heads, as the mockup labels them', async () => {
  const plausible = [
    'Sehr plausibel',
    'Plausibel',
    'Eher plausibel',
    'Eher nicht plausibel',
    'Nicht plausibel',
    'Gar nicht plausibel',
  ]
  const { container } = await view(true, pckStep(revisedPck[1], 2, 32))
  expect(
    Array.from(container.querySelectorAll('.matrix__scale-label')).map(
      (label) => label.textContent,
    ),
  ).toEqual(plausible)
  // The worksheet's own wording stays in the prompt, with its two anchors.
  expect(container.querySelector('.matrix__prompt:last-of-type')).toHaveTextContent(
    'Bewerten Sie jede Aussage auf einer sechsstufigen Skala (1 = sehr plausibel, 6 = überhaupt nicht plausibel).',
  )
  expect(
    screen.getByRole('radio', {
      name: 'Der Schüler nimmt möglicherweise an, dass die Schleife immer beim ersten Element des Arrays beginnt.: 6 – Gar nicht plausibel',
    }),
  ).toBeInTheDocument()
})

test.each(firstPck)(
  'first-pilot PCK task $source_task keeps its three authored columns and compact scales',
  async (page) => {
    const { container } = await view(true, pckStep(page, 1, 25))
    expect(screen.getByRole('heading', { level: 2, name: 'Fachdidaktisches Wissen' })).toBeVisible()
    const root = container.querySelector('.pretest-page')!
    expect(root).toHaveClass('pretest-page--pilot', 'pretest-page--pck')
    expect(root).not.toHaveClass('pretest-page--pck-item')
    expect(container.querySelectorAll('.qlist--columns > .question-column')).toHaveLength(3)
    expect(container.querySelector('.matrix__scale-label')).toBeNull()
    expect(container.querySelector('caption')).toBeNull()
    expect(container.querySelectorAll('.matrix').length).toBeGreaterThan(1)
    for (const row of container.querySelectorAll<HTMLElement>('.matrix__table tbody tr')) {
      expect(within(row).getAllByRole('radio')).toHaveLength(5)
    }
  },
)

test('a legacy study shows a PCK page without either pilot layout', async () => {
  const { container } = await view(false, pckStep(revisedPck[1], 2, 32))
  const root = container.querySelector('.pretest-page')!
  expect(root).toHaveClass('pretest-page--pck')
  expect(root).not.toHaveClass('pretest-page--pilot')
  expect(root).not.toHaveClass('pretest-page--pck-item')
  expect(container.querySelector('.study-stimulus, .question-column, footer')).toBeNull()
  expect(container.querySelector('.matrix__scale-label')).toBeNull()
})

test('a revised page given authored columns in the admin goes back to the column layout', async () => {
  const page = revisedPck[4]
  const { container } = await view(
    true,
    pckStep(
      {
        ...page,
        questions: page.questions.map((question, index) => ({
          ...question,
          layout_column: (index + 1) as 1 | 2,
        })),
      },
      5,
      32,
    ),
  )
  expect(container.querySelector('.pretest-page')).not.toHaveClass('pretest-page--pck-item')
  expect(container.querySelectorAll('.question-column')).toHaveLength(2)
})

test.each(revisedPilot.ck_tasks.map((task) => task.question as unknown as Question))(
  '$id keeps the common question and its own task on separate lines',
  async (question) => {
    const lead =
      'Debugging-Aufgabe – In welcher Zeile befindet sich der Fehler? Was ist der Fehler?'
    const { container } = await view(true, { ...step, questions: [question] })
    const field = container.querySelector('.qfield')!
    expect(field).toHaveClass('qfield--debugging')
    const legend = field.querySelector('.qfield__text')!
    const [first, second, ...rest] = legend.textContent!.split('\n')
    expect(first).toBe(lead)
    expect(second.endsWith(' *')).toBe(true)
    expect(second.length).toBeGreaterThan(10)
    expect(rest).toEqual([])
    // Still one name for assistive technology; the break is only how it is shown.
    expect(
      screen.getByRole('group', {
        name: (name) => name.replace(/\s+/g, ' ') === `${question.text.replace('\n', ' ')} *`,
      }),
    ).toBe(field)
  },
)
