import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { SessionStep } from '../api/participant'
import { ToastProvider } from '../components/Toast'
import { AuthProvider } from '../contexts/AuthContext'
import SessionPage from './SessionPage'

const respond = vi.fn().mockResolvedValue({})
let currentStepIndex = 0

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
    video_id: null,
    page: 2,
    page_count: 2,
    questions: [{ id: 'ck_pre_loop', type: 'number', text: 'Schleifen' }],
  },
  { index: 2, completed: false, kind: 'sosci', variant: 'pretest', url: '', id_param: 'id', participant_id: 'T-1' },
]

vi.mock('../hooks/participant', () => ({
  useMe: () => ({ data: { id: 'T-1', study_name: 'S', status: 'active' } }),
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

beforeEach(() => {
  currentStepIndex = 0
  respond.mockClear()
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
