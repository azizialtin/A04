import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { SessionStep } from '../api/participant'
import type { DisplayGuardSnapshot } from '../lib/displayGuard'
import { ToastProvider } from '../components/Toast'
import { AuthProvider } from '../contexts/AuthContext'
import { enqueue } from '../lib/outbox'
import SessionPage from './SessionPage'

const respond = vi.fn().mockResolvedValue({})
const enter = vi.fn()
const stepBack = vi.fn()
let currentStepIndex = 0
let sessionRefetchError = false
let me: { id: string; study_name: string; status: string } | undefined
let guard: DisplayGuardSnapshot
const useGuard = vi.fn((owner: string | undefined, scope: 'required' | 'monitor' | 'suspended') => {
  guard = {
    ...guard,
    owner: owner ?? null,
    required: scope === 'required',
    focusRequired: scope === 'required',
  }
  return guard
})
vi.mock('../hooks/useDisplayGuard', () => ({
  useDisplayGuard: (owner: string | undefined, scope: 'required' | 'monitor' | 'suspended') =>
    useGuard(owner, scope),
}))
vi.mock('../lib/displayGuard', async (original) => ({
  ...(await original<typeof import('../lib/displayGuard')>()),
  checkDisplayGuard: () =>
    !guard.enabled || !guard.required || guard.phase === 'verified' || guard.unverifiedContinuation,
  getDisplayGuardSnapshot: () => guard,
  resumeDisplayGuard: vi.fn(),
}))

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
  useEnterQuestionnaire: () => ({ mutateAsync: enter, isPending: false }),
  useFinishCK: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('../hooks/useOutbox', () => ({ useOutbox: () => 0 }))
// The case screen brings the player, the tracker and the recorder with it;
// here it only has to be the screen the bar is drawn over.
vi.mock('../components/session/CaseVideoScreen', () => ({
  default: () => <div>Fallvideo</div>,
}))
vi.mock('../components/session/ThinkAloudScreen', () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button onClick={onComplete}>Replay next</button>
  ),
}))
vi.mock('../components/session/ThanksScreen', () => ({ default: () => <p>Finished</p> }))
vi.mock('../hooks/useGazePreflight', () => ({
  useGazePreflight: () => ({
    state: 'tracking',
    retry: vi.fn(),
    close: vi.fn(),
    received: 1,
    valid: 1,
  }),
}))
vi.mock('../lib/screenCapture', () => ({
  bridgeCanRecord: vi.fn().mockResolvedValue(true),
  prepareCapture: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/outbox', () => ({ enqueue: vi.fn() }))
const logged = vi.mocked(enqueue)

beforeEach(() => {
  currentStepIndex = 0
  sessionRefetchError = false
  me = { id: 'T-1', study_name: 'S', status: 'active' }
  respond.mockClear()
  stepBack.mockClear()
  logged.mockClear()
  useGuard.mockClear()
  enter.mockReset().mockResolvedValue({ visit_id: 'guarded-visit', section_timing: null })
  localStorage.clear()
  sessionStorage.clear()
  guard = {
    enabled: false,
    phase: 'disabled',
    owner: 'T-1',
    required: true,
    focusRequired: true,
    reasons: [],
    generation: 0,
    unverifiedContinuation: false,
  }
})

const view = () =>
  render(
    <AuthProvider>
      <ToastProvider>
        <SessionPage />
      </ToastProvider>
    </AuthProvider>,
  )

const baseStep = { index: 0, completed: false }
const scopeCases: {
  name: string
  step: SessionStep
  scope: 'required' | 'monitor' | 'suspended'
}[] = [
  { name: 'questionnaire', step: STEPS[0], scope: 'required' },
  { name: 'video', step: { ...STEPS[4], index: 0 }, scope: 'required' },
  {
    name: 'diagnosis',
    step: {
      ...baseStep,
      kind: 'diagnosis',
      video_id: 7,
      task_description: '',
      section: '',
      questions: [],
    },
    scope: 'required',
  },
  {
    name: 'outro with a questionnaire',
    step: {
      ...baseStep,
      kind: 'case_outro',
      video_id: 7,
      phase_type: 'training',
      questionnaire_id: 9,
      title: '',
      section: '',
      instruction: '',
      questions: [{ id: 'effort', type: 'number', text: 'Effort' }],
    },
    scope: 'required',
  },
  {
    name: 'outro with an empty but assigned questionnaire',
    step: {
      ...baseStep,
      kind: 'case_outro',
      video_id: 7,
      phase_type: 'training',
      questionnaire_id: 9,
      title: '',
      section: '',
      instruction: '',
      questions: [],
    },
    scope: 'required',
  },
  {
    name: 'existing calibration safety',
    step: { ...baseStep, kind: 'calibration' },
    scope: 'required',
  },
  { name: 'welcome', step: { ...baseStep, kind: 'welcome' }, scope: 'monitor' },
  {
    name: 'text page',
    step: {
      ...baseStep,
      kind: 'text_page',
      key: 'video_start',
      title: 'Instructions',
      body: 'Read before continuing.',
    },
    scope: 'monitor',
  },
  {
    name: 'section introduction',
    step: {
      ...baseStep,
      kind: 'section_intro',
      section_key: 'ck_tasks',
      title: 'CK instructions',
      body: 'Instructions before the timed exercises.',
      time_limit_seconds: 420,
    },
    scope: 'monitor',
  },
  {
    name: 'case introduction',
    step: {
      ...baseStep,
      kind: 'case_intro',
      phase_type: 'training',
      video_id: 7,
      title: 'Fall 1',
      body: 'Any questions?',
    },
    scope: 'monitor',
  },
  {
    name: 'phase transition',
    step: { ...baseStep, kind: 'phase_transition', phase_type: 'training', phase_number: 1 },
    scope: 'monitor',
  },
  { name: 'outro without a questionnaire', step: { ...STEPS[3], index: 0 }, scope: 'monitor' },
  { name: 'SoSci', step: { ...STEPS[2], index: 0 }, scope: 'suspended' },
  {
    name: 'think-aloud replay',
    step: {
      ...baseStep,
      kind: 'think_aloud',
      video_id: 7,
      phase_type: 'training',
      case_number: 1,
      case_total: 1,
      batch_position: 1,
      batch_size: 1,
    },
    scope: 'suspended',
  },
  { name: 'end page', step: { ...baseStep, kind: 'thanks' }, scope: 'suspended' },
]

test.each(scopeCases)('$name uses the intended gaze guard scope', ({ step, scope }) => {
  const original = STEPS[0]
  STEPS[0] = step
  guard = { ...guard, enabled: true, phase: 'blocked' }
  try {
    const { container } = view()
    expect(useGuard).toHaveBeenLastCalledWith('T-1', scope)
    const content = container.querySelector('.display-guard__content') as HTMLElement
    expect(content.inert).toBe(scope === 'required')
    expect(content.hasAttribute('aria-hidden')).toBe(scope === 'required')
    expect(screen.queryByRole('dialog', { name: 'Bildschirmeinstellung prüfen' }) !== null).toBe(
      scope === 'required',
    )
    expect(enter).not.toHaveBeenCalled()
    expect(
      logged.mock.calls.filter(([, event]) => event.event_type === 'questionnaire_page_entered'),
    ).toHaveLength(0)
  } finally {
    STEPS[0] = original
  }
})

test.each(scopeCases.filter(({ scope, name }) => scope === 'monitor' && name !== 'welcome'))(
  '$name remains usable when display verification is not valid',
  async ({ step }) => {
    const original = STEPS[0]
    STEPS[0] = step
    guard = { ...guard, enabled: true, phase: 'blocked' }
    try {
      view()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Weiter' })))
      expect(currentStepIndex).toBe(1)
      expect(respond).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeNull()
    } finally {
      STEPS[0] = original
    }
  },
)

test('CK instructions remain readable while the first timed page waits for verification', async () => {
  const originals = [...STEPS]
  STEPS[0] = scopeCases.find(({ name }) => name === 'section introduction')!.step
  STEPS[1] = { ...STEPS[1], section_key: 'ck_tasks' } as SessionStep
  guard = { ...guard, enabled: true, phase: 'blocked' }
  try {
    const { rerender } = view()
    const refresh = () =>
      rerender(
        <AuthProvider>
          <ToastProvider>
            <SessionPage />
          </ToastProvider>
        </AuthProvider>,
      )
    expect(screen.getByRole('heading', { name: 'CK instructions' })).toBeVisible()
    expect(enter).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
    refresh()
    expect(screen.getByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeVisible()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(enter).not.toHaveBeenCalled()
    guard = { ...guard, phase: 'verified' }
    await act(async () => refresh())
    expect(enter).toHaveBeenCalledOnce()
    expect(enter).toHaveBeenCalledWith(
      expect.objectContaining({ step_index: 1, questionnaire_id: 2 }),
    )
    expect(screen.getByRole('spinbutton')).toBeEnabled()
  } finally {
    STEPS.splice(0, STEPS.length, ...originals)
  }
})

test('SoSci opens separately and its measured return waits for fresh verification', () => {
  const original = STEPS[0]
  STEPS[0] = { ...STEPS[2], index: 0, url: 'https://survey.test/form' } as SessionStep
  guard = { ...guard, enabled: true, phase: 'blocked' }
  try {
    const { rerender } = view()
    expect(screen.queryByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeNull()
    const survey = screen.getByRole('link', { name: 'Fragebogen öffnen' })
    expect(survey).toHaveAttribute('target', '_blank')
    expect(survey).toHaveAttribute('href', 'https://survey.test/form?id=T-1')
    expect(
      screen.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' }),
    ).toBeDisabled()
    fireEvent.click(survey)
    fireEvent.click(screen.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' }))
    expect(currentStepIndex).toBe(1)
    rerender(
      <AuthProvider>
        <ToastProvider>
          <SessionPage />
        </ToastProvider>
      </AuthProvider>,
    )
    expect(useGuard).toHaveBeenLastCalledWith('T-1', 'required')
    expect(screen.getByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeVisible()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  } finally {
    STEPS[0] = original
  }
})

test('an unchanged display stays usable through case instructions into the next measured page', async () => {
  const original = STEPS[0]
  STEPS[0] = scopeCases.find(({ name }) => name === 'case introduction')!.step
  guard = { ...guard, enabled: true, phase: 'verified' }
  try {
    const { rerender } = view()
    expect(useGuard).toHaveBeenLastCalledWith('T-1', 'monitor')
    expect(screen.queryByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Weiter' })))
    rerender(
      <AuthProvider>
        <ToastProvider>
          <SessionPage />
        </ToastProvider>
      </AuthProvider>,
    )
    expect(useGuard).toHaveBeenLastCalledWith('T-1', 'required')
    expect(screen.getByRole('spinbutton')).toBeEnabled()
    expect(screen.queryByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeNull()
  } finally {
    STEPS[0] = original
  }
})

test('supervisor navigation remains available on an unmeasured page with invalid display settings', () => {
  currentStepIndex = 3
  guard = { ...guard, enabled: true, phase: 'blocked' }
  view()
  expect(useGuard).toHaveBeenLastCalledWith('T-1', 'monitor')
  fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true, altKey: true, shiftKey: true })
  expect(screen.queryByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Zurück' }))
  expect(stepBack).toHaveBeenCalledOnce()
})

test('a completed script without a current step cannot be blocked by display verification', () => {
  currentStepIndex = STEPS.length
  guard = { ...guard, enabled: true, phase: 'blocked' }
  view()
  expect(useGuard).toHaveBeenLastCalledWith('T-1', 'suspended')
  expect(screen.getByText('Finished')).toBeVisible()
  expect(screen.queryByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeNull()
})

test('the display guard gates entries, preserves the mounted draft and holds the next page', async () => {
  guard = { ...guard, enabled: true, phase: 'blocked' }
  const { rerender, container } = view()
  const refresh = () =>
    rerender(
      <AuthProvider>
        <ToastProvider>
          <SessionPage />
        </ToastProvider>
      </AuthProvider>,
    )
  expect(screen.getByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })).toBeVisible()
  expect(screen.queryByRole('spinbutton')).toBeNull()
  expect(logged).not.toHaveBeenCalled()

  guard = { ...guard, phase: 'verified' }
  refresh()
  const field = screen.getByRole('spinbutton')
  const next = screen.getByRole('button', { name: 'Weiter' })
  fireEvent.change(field, { target: { value: '34' } })
  expect(
    logged.mock.calls.filter(([, event]) => event.event_type === 'questionnaire_page_entered'),
  ).toHaveLength(1)

  guard = { ...guard, phase: 'blocked', generation: 1 }
  refresh()
  expect(field).toBeInTheDocument()
  expect(field).toHaveValue(34)
  expect((container.querySelector('.display-guard__content') as HTMLElement).inert).toBe(true)
  fireEvent.click(next)
  fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true, altKey: true, shiftKey: true })
  expect(respond).not.toHaveBeenCalled()
  expect(stepBack).not.toHaveBeenCalled()

  // A timer may advance the script while the old page is blocked.
  currentStepIndex = 1
  refresh()
  expect(field).not.toBeInTheDocument()
  expect(container.querySelector('input')).toBeNull()
  expect(
    logged.mock.calls.filter(([, event]) => event.event_type === 'questionnaire_page_entered'),
  ).toHaveLength(1)
  guard = { ...guard, phase: 'verified' }
  refresh()
  expect(screen.getByRole('spinbutton')).toHaveValue(null)
  expect(
    logged.mock.calls.filter(([, event]) => event.event_type === 'questionnaire_page_entered'),
  ).toHaveLength(2)
})

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

test('expected CK deadline takeover does not display a generic connection error', async () => {
  respond.mockRejectedValueOnce(
    Object.assign(new Error('deadline'), {
      isAxiosError: true,
      response: { status: 409, data: { detail: { code: 'ck_deadline_expired' } } },
    }),
  )
  view()
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '34' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  })
  expect(respond).toHaveBeenCalledOnce()
  expect(screen.queryByText('Etwas ist schiefgelaufen. Bitte laden Sie die Seite neu.')).toBeNull()
  expect(currentStepIndex).toBe(0)
})
