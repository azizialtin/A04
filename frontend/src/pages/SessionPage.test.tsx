import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { SessionStep } from '../api/participant'
import { ToastProvider } from '../components/Toast'
import { AuthProvider } from '../contexts/AuthContext'
import { enqueue } from '../lib/outbox'
import SessionPage from './SessionPage'

const respond = vi.fn().mockResolvedValue({})
let currentStepIndex = 0
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
]

vi.mock('../hooks/participant', () => ({
  useMe: () => ({ data: me }),
  useSession: () => ({
    data: {
      status: 'active',
      current_step_index: currentStepIndex,
      total_steps: STEPS.length,
      steps: STEPS,
    },
  }),
  useUpdateProgress: () => ({ mutate: (index: number) => (currentStepIndex = index) }),
  useRespondQuestionnaire: () => ({ mutateAsync: respond, isPending: false }),
}))

vi.mock('../hooks/useOutbox', () => ({ useOutbox: () => 0 }))
vi.mock('../lib/outbox', () => ({ enqueue: vi.fn() }))
const logged = vi.mocked(enqueue)

beforeEach(() => {
  currentStepIndex = 0
  me = { id: 'T-1', study_name: 'S', status: 'active' }
  respond.mockClear()
  logged.mockClear()
})

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
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
  expect(respond.mock.calls[1][0].answers).toEqual({ ck_pre_loop: 5 })
})

test('logs when a question page is entered and when its answers went in', async () => {
  view()

  // Entered on arrival, named for the page and its section, with the clock.
  expect(logged).toHaveBeenCalledTimes(1)
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
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))

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
  expect(logged).toHaveBeenCalledTimes(1)
  expect(logged.mock.calls[0][1]).toMatchObject({ event_type: 'questionnaire_page_entered' })
})

test('a closing screen with no questions on it logs no page events', () => {
  currentStepIndex = 3
  view()
  expect(logged).not.toHaveBeenCalled()
})
