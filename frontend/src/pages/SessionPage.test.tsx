import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import type { SessionStep } from '../api/participant'
import { ToastProvider } from '../components/Toast'
import { AuthProvider } from '../contexts/AuthContext'
import { enqueue } from '../lib/outbox'
import SessionPage from './SessionPage'

const respond = vi.fn().mockResolvedValue({})
const stepBack = vi.fn()
let currentStepIndex = 0
let sessionRefetchError = false
let outboxStatus = { pending: 0, retrying: 0 }
let me: { id: string; study_name: string; status: string } | undefined

// The pre-test block: two pages of the same step kind, back to back. Everything
// after them is irrelevant here, so the script stops at the survey hand-off.
const STEPS: SessionStep[] = [
  {
    index: 0,
    completed: false,
    kind: 'questionnaire',
    questionnaire_id: 1,
    placement: 'pre_test',
    title: 'Angaben zur Person',
    description: '',
    section: 'Demographics',
    video_id: null,
    page: 1,
    page_count: 2,
    questions: [{ id: 'age', type: 'number', text: 'Alter' }],
  },
  {
    index: 1,
    completed: false,
    kind: 'questionnaire',
    questionnaire_id: 2,
    placement: 'pre_test',
    title: 'Fachwissen Programmierung',
    description: '',
    section: 'CK-Pretest',
    video_id: null,
    page: 2,
    page_count: 2,
    questions: [{ id: 'ck_pre_loop', type: 'number', text: 'Schleifen' }],
  },
  {
    index: 2,
    completed: false,
    kind: 'sosci',
    variant: 'pretest',
    url: '',
    id_param: 'id',
    participant_id: 'T-1',
  },
  // A closing screen with no battery on it: nothing to answer, nothing to log.
  {
    index: 3,
    completed: false,
    kind: 'case_outro',
    video_id: 7,
    phase_type: 'training',
    questionnaire_id: null,
    title: '',
    section: '',
    instruction: '',
    questions: [],
  },
  {
    index: 4,
    completed: false,
    kind: 'case_video',
    video_id: 7,
    title: 'Fall 1',
    task_description: '',
    info_text: '',
    student_task_text: '',
    time_limit_seconds: null,
  },
]

vi.mock('../hooks/participant', () => ({
  useMe: () => ({ data: me }),
  useSession: () => ({
    isError: sessionRefetchError,
    data: {
      status: 'active',
      current_step_index: currentStepIndex,
      total_steps: STEPS.length,
      steps: STEPS,
    },
  }),
  useUpdateProgress: () => ({
    mutate: (value: number | { index: number }) =>
      (currentStepIndex = typeof value === 'number' ? value : value.index),
    mutateAsync: async (value: number | { index: number }) =>
      (currentStepIndex = typeof value === 'number' ? value : value.index),
  }),
  useRespondQuestionnaire: () => ({ mutateAsync: respond, isPending: false }),
  useStepBack: () => ({ mutate: stepBack, isPending: false }),
  useEnterQuestionnaire: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useFinishCK: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('../hooks/useOutbox', () => ({ useOutbox: () => outboxStatus }))
// The case screen brings the player, the tracker and the recorder with it;
// here it only has to be the screen the bar is drawn over.
vi.mock('../components/session/CaseVideoScreen', () => ({
  default: () => <div>Fallvideo</div>,
}))
vi.mock('../lib/outbox', () => ({ enqueue: vi.fn() }))
const logged = vi.mocked(enqueue)

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  currentStepIndex = 0
  sessionRefetchError = false
  outboxStatus = { pending: 0, retrying: 0 }
  me = { id: 'T-1', study_name: 'S', status: 'active' }
  respond.mockClear()
  stepBack.mockClear()
  logged.mockClear()
  localStorage.clear()
})

afterEach(() => vi.restoreAllMocks())

const view = () =>
  render(
    <AuthProvider>
      <ToastProvider>
        <SessionPage />
      </ToastProvider>
    </AuthProvider>,
  )

test('each pre-test page submits only its own answers', async () => {
  // The two pages are adjacent steps of the same kind. Reusing the component
  // between them would carry page one's answers — and its clock — into page
  // two's response row, and nothing on screen would say so.
  const { rerender } = view()

  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '34' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  })
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
  expect(respond.mock.calls[0][0].answers).toEqual({ age: 34 })

  rerender(
    <AuthProvider>
      <ToastProvider>
        <SessionPage />
      </ToastProvider>
    </AuthProvider>,
  )

  expect(screen.getByRole('heading', { name: 'Fachwissen Programmierung' })).toBeInTheDocument()
  expect(screen.getByRole('spinbutton')).toHaveValue(null)

  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  })
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
  expect(respond.mock.calls[1][0].answers).toEqual({ ck_pre_loop: 5 })
})

test('logs when a question page is entered and when its answers went in', async () => {
  view()

  // Entered on arrival, named for the page and its section, with the clock.
  expect(
    logged.mock.calls.filter(([, event]) => event.event_type === 'questionnaire_page_entered'),
  ).toHaveLength(1)
  expect(logged).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      event_type: 'questionnaire_page_entered',
      client_ts: expect.any(Number),
      payload: expect.objectContaining({
        kind: 'questionnaire',
        title: 'Angaben zur Person',
        section: 'Demographics',
        page: 1,
        page_count: 2,
      }),
    }),
  )

  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '34' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  })

  await vi.waitFor(() =>
    expect(logged).toHaveBeenCalledWith(
      'event',
      expect.objectContaining({
        event_type: 'questionnaire_page_submitted',
        payload: expect.objectContaining({
          title: 'Angaben zur Person',
          section: 'Demographics',
          time_spent_seconds: expect.any(Number),
        }),
      }),
    ),
  )
})

test('the entry is logged once the outbox knows whose it is, not before', () => {
  // The session can arrive before the participant does; a write queued before
  // the outbox has an owner is dropped, so the entry waits for both.
  me = undefined
  const { rerender } = view()
  expect(logged).not.toHaveBeenCalled()

  me = { id: 'T-1', study_name: 'S', status: 'active' }
  rerender(
    <AuthProvider>
      <ToastProvider>
        <SessionPage />
      </ToastProvider>
    </AuthProvider>,
  )
  expect(
    logged.mock.calls.filter(([, event]) => event.event_type === 'questionnaire_page_entered'),
  ).toHaveLength(1)
  expect(logged).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({ event_type: 'questionnaire_page_entered' }),
  )
})

test('a closing screen with no questions on it logs no page events', () => {
  currentStepIndex = 3
  view()
  expect(logged).not.toHaveBeenCalled()
})

const chord = { code: 'KeyB', ctrlKey: true, altKey: true, shiftKey: true }

test('the supervisor chord asks first, naming both screens, then steps back', () => {
  currentStepIndex = 1
  view()
  expect(screen.queryByRole('dialog')).toBeNull()

  fireEvent.keyDown(window, chord)
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveTextContent('Von „Fragebogen – Fachwissen Programmierung“')
  expect(dialog).toHaveTextContent('zurück zu „Fragebogen – Angaben zur Person“')
  expect(stepBack).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Zurück' }))
  expect(stepBack).toHaveBeenCalledTimes(1)
})

test('cancelling, a lesser chord, and the first screen all leave the run alone', () => {
  view()
  fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true, shiftKey: true })
  expect(screen.queryByRole('dialog')).toBeNull()

  fireEvent.keyDown(window, chord)
  expect(screen.getByText('Dies ist der erste Schritt – davor gibt es nichts.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Zurück' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(stepBack).not.toHaveBeenCalled()
})

test('a page the run was stepped back onto opens with its stored answers', () => {
  currentStepIndex = 0
  STEPS[0] = { ...STEPS[0], previous_answers: { age: 30 } } as SessionStep
  try {
    view()
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('30')
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled()
  } finally {
    STEPS[0] = { ...STEPS[0], previous_answers: undefined } as SessionStep
  }
})

test('the case screen keeps the progress bar, laid over its top edge', () => {
  currentStepIndex = 4
  const { container } = view()
  expect(screen.getByText('Fallvideo')).toBeInTheDocument()
  const bar = container.querySelector('.shell__progress--overlay > div') as HTMLElement
  expect(bar).not.toBeNull()
  expect(bar.style.width).toBe('80%')
})

test('a background session refresh failure keeps the acknowledged cached screen usable', () => {
  currentStepIndex = 4
  sessionRefetchError = true
  view()
  expect(screen.getByText('Fallvideo')).toBeInTheDocument()
  expect(screen.queryByText('Die Sitzung konnte nicht geladen werden.')).not.toBeInTheDocument()
})

test('a questionnaire page has the bar in its header, not laid over it', () => {
  const { container } = view()
  expect(container.querySelector('.shell__progress')).not.toBeNull()
  expect(container.querySelector('.shell__progress--overlay')).toBeNull()
})

test.each([0, 4])('only failed background saves display the retry warning on step %s', (index) => {
  currentStepIndex = index
  outboxStatus = { pending: 2, retrying: 0 }
  const content = () => (
    <AuthProvider>
      <ToastProvider>
        <SessionPage />
      </ToastProvider>
    </AuthProvider>
  )
  const { container, rerender } = render(content())
  expect(container.querySelector('.unsent')).toBeNull()

  outboxStatus = { pending: 2, retrying: 1 }
  rerender(content())
  expect(container.querySelector('.unsent')).toHaveTextContent('1 Eingabe noch nicht gespeichert')

  outboxStatus = { pending: 1, retrying: 0 }
  rerender(content())
  expect(container.querySelector('.unsent')).toBeNull()
})

test('completion still waits for normal background saves before the next participant', () => {
  currentStepIndex = STEPS.length
  outboxStatus = { pending: 1, retrying: 0 }
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <SessionPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: 'Mit der nächsten Person beginnen' })).toBeDisabled()
})

test.each([0, 4])('keeps tracking notices before the content on step %s', (index) => {
  currentStepIndex = index
  const { container } = view()
  const sessionScreen = container.querySelector('.session-screen')
  const notices = sessionScreen?.querySelector(':scope > .gaze-health-stack')
  expect(notices).toBeInTheDocument()
  expect(notices?.nextElementSibling).not.toBeNull()
})

test('starts each displayed step at the top, without jumping on same-page updates', () => {
  me = undefined
  const content = () => (
    <MemoryRouter><AuthProvider><ToastProvider><SessionPage /></ToastProvider></AuthProvider></MemoryRouter>
  )
  const { rerender } = render(content())
  const refresh = () => rerender(content())
  expect(window.scrollTo).not.toHaveBeenCalled()
  me = { id: 'T-1', study_name: 'S', status: 'active' }
  refresh()
  expect(window.scrollTo).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '34' } })
  refresh()
  sessionRefetchError = true
  refresh()
  expect(window.scrollTo).toHaveBeenCalledTimes(1)

  // Consecutive questionnaires, other screen types, completion and supervisor back.
  for (const index of [1, 2, 3, 4, STEPS.length, 0]) {
    vi.mocked(window.scrollTo).mockClear()
    currentStepIndex = index
    refresh()
    expect(window.scrollTo).toHaveBeenCalledOnce()
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' })
  }
})

test('failed answers keep the participant on the same page without resetting scroll', async () => {
  respond.mockRejectedValueOnce(new Error('Network unavailable'))
  view()
  vi.mocked(window.scrollTo).mockClear()
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '34' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  })
  expect(respond).toHaveBeenCalledOnce()
  expect(currentStepIndex).toBe(0)
  expect(screen.getByRole('spinbutton')).toHaveValue(34)
  expect(window.scrollTo).not.toHaveBeenCalled()
})
