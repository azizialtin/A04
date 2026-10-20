import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import type { RosterRow, StudyStats } from '../../api/admin'
import StatsSection from './StatsSection'

const useStudyStats = vi.fn()
const useParticipantStats = vi.fn()
vi.mock('../../hooks/admin', () => ({
  useStudyStats: () => useStudyStats(),
  useParticipantStats: (id: string) => useParticipantStats(id),
}))

function participant(id: string): RosterRow {
  return {
    id,
    status: 'registered',
    created_at: null,
    cases: 0,
    assigned_sequence: false,
    video_set: null,
    step: 0,
    total_steps: 54,
    progress: 0,
    started_at: null,
    completed_at: null,
    session_minutes: null,
    first_event_at: null,
    last_event_at: null,
    events: 0,
    notes: 0,
    note_chars: 0,
    diagnoses: 0,
    responses: 0,
    watch_seconds: 0,
    gaze_recordings: 0,
    gaze_samples: 0,
    screens_stored: 0,
    screens_failed: 0,
    screen_bytes: 0,
    calibrations: 0,
    best_offset: null,
  }
}

const data: StudyStats = {
  generated_at: '2026-10-19T10:00:00Z',
  study: { id: 8, name: 'Teststudie', description: '', is_active: true, created_at: null },
  participants: {
    total: 2,
    registered: 2,
    active: 0,
    completed: 0,
    started: 0,
    completed_sessions: 0,
    completion_rate: 0,
    avg_progress: 0,
    avg_session_minutes: null,
    median_session_minutes: null,
    with_gaze: 0,
    with_screen: 0,
    with_calibration: 0,
    never_started: 2,
  },
  data: {
    notes: 0,
    note_chars: 0,
    diagnoses: 0,
    responses: 0,
    events: 0,
    gaze_recordings: 0,
    gaze_samples: 0,
    screens_stored: 0,
    screens_failed: 0,
    screen_bytes: 0,
    watch_seconds: 0,
  },
  cases: [],
  questionnaires: [],
  sections: [],
  calibration: { attempts: 0, participants: 0, by_status: {} },
  roster: [participant('TEST-P01'), participant('TEST-P02')],
  activity: [],
  events_by_type: [],
}

const scrollIntoView = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  HTMLElement.prototype.scrollIntoView = scrollIntoView
  useStudyStats.mockReturnValue({ data, isLoading: false, isError: false })
  useParticipantStats.mockReturnValue({ isLoading: true, isError: false })
})

test('Details reveals and focuses the selected participant while their data loads', async () => {
  const user = userEvent.setup()
  render(<StatsSection studyId={8} />)
  const open = screen.getAllByRole('button', { name: 'Details' })[0]

  await user.click(open)

  const panel = screen.getByRole('region', { name: 'Details für TEST-P01' })
  expect(panel).toHaveFocus()
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  expect(within(panel).getByText('Wird geladen…')).toBeInTheDocument()
  expect(useParticipantStats).toHaveBeenLastCalledWith('TEST-P01')
  expect(open).toHaveAttribute('aria-expanded', 'true')
  expect(open).toHaveAttribute('aria-controls', panel.id)

  await user.click(within(panel).getByRole('button', { name: 'Schließen' }))

  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(open).toHaveFocus()
  expect(open).toHaveAttribute('aria-expanded', 'false')
})

test('Details reveals an already-open participant again after returning to the roster', async () => {
  const user = userEvent.setup()
  render(<StatsSection studyId={8} />)
  const open = screen.getAllByRole('button', { name: 'Details' })[0]
  await user.click(open)
  scrollIntoView.mockClear()

  await user.click(open)

  expect(scrollIntoView).toHaveBeenCalledOnce()
  expect(screen.getByRole('region', { name: 'Details für TEST-P01' })).toHaveFocus()
})

test('reveals the panel again when its initial loading state settles', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<StatsSection studyId={8} />)
  await user.click(screen.getAllByRole('button', { name: 'Details' })[0])
  scrollIntoView.mockClear()

  useParticipantStats.mockReturnValue({ isLoading: false, isError: true })
  rerender(<StatsSection studyId={8} />)

  expect(scrollIntoView).toHaveBeenCalledOnce()
  expect(screen.getByRole('region', { name: 'Details für TEST-P01' })).toHaveFocus()
})

test('switching participants reveals the new details and keeps failures visible', async () => {
  const user = userEvent.setup()
  render(<StatsSection studyId={8} />)
  const [first, second] = screen.getAllByRole('button', { name: 'Details' })
  await user.click(first)
  useParticipantStats.mockReturnValue({ isLoading: false, isError: true })
  scrollIntoView.mockClear()

  await user.click(second)

  const panel = screen.getByRole('region', { name: 'Details für TEST-P02' })
  expect(panel).toHaveFocus()
  expect(scrollIntoView).toHaveBeenCalledOnce()
  expect(within(panel).getByText('Statistik nicht verfügbar.')).toBeInTheDocument()
  expect(useParticipantStats).toHaveBeenLastCalledWith('TEST-P02')
  expect(first).toHaveAttribute('aria-expanded', 'false')
  expect(second).toHaveAttribute('aria-expanded', 'true')

  await user.click(within(panel).getByRole('button', { name: 'Schließen' }))
  expect(second).toHaveFocus()
})
