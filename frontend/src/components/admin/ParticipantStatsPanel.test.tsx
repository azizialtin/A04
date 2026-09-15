import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { ParticipantStats } from '../../api/admin'
import ParticipantStatsPanel from './ParticipantStatsPanel'

const useParticipantStats = vi.fn()
vi.mock('../../hooks/admin', () => ({
  useParticipantStats: (id: string | null) => useParticipantStats(id),
}))

/** A participant six cases into a nine-case run. */
function stats(overrides: Partial<ParticipantStats> = {}): ParticipantStats {
  return {
    generated_at: '2026-08-20T20:50:00Z',
    id: 'P02',
    study_id: 1,
    study_name: 'A04',
    status: 'active',
    created_at: '2026-08-20T19:34:29Z',
    session: {
      started_at: '2026-08-20T20:10:22Z',
      completed_at: null,
      minutes: null,
      step: 36,
      total_steps: 54,
      progress: 66.7,
      current_step: 'case_intro',
      assigned_sequence: false,
      video_set: null,
    },
    activity: {
      events: 93,
      first_at: '2026-08-20T20:10:22Z',
      last_at: '2026-08-20T20:44:44Z',
      minutes: 34.4,
    },
    totals: {
      cases: 2,
      cases_entered: 1,
      cases_completed: 1,
      watch_seconds: 85.9,
      on_screen_seconds: 117.4,
      notes: 2,
      note_chars: 45,
      diagnoses: 1,
      diagnosis_words: 11,
      responses: 14,
      gaze_samples: 13443,
      screens_stored: 1,
      screens_failed: 1,
      screen_bytes: 9259283,
    },
    cases: [
      {
        slot_index: 0,
        video_id: 1,
        title: 'Fall 1',
        phase_type: 'pre_test',
        duration_seconds: 60,
        time_limit_seconds: 60,
        entered: true,
        watch_seconds: 25.9,
        on_screen_seconds: 30.9,
        max_playhead_seconds: 15,
        play_spans: 3,
        coverage: 25,
        plays: 2,
        pauses: 1,
        seeks: 1,
        replays: 1,
        completed: true,
        info_opens: 0,
        task_opens: 0,
        notes_focused: 0,
        typing_bursts: 0,
        notes: { snapshots: 2, chars: 45, last_at: null, last_video_time: null },
        diagnosis: { chars: 60, words: 11, seconds: 5, submitted_at: '2026-08-20T20:38:57Z' },
        outro_answered: true,
        ratings_answered: true,
        gaze: {
          recordings: 1,
          samples: 3601,
          sampling_rate_hz: 120,
          expected_samples: 3708,
          yield: 97.1,
          started_at: null,
          completed_at: null,
        },
        screen: {
          id: 10,
          status: 'stored',
          error: null,
          duration_ms: 29400,
          byte_size: 2781395,
          width: 1920,
          height: 1080,
          fps: 30,
          recorder: 'bridge',
        },
      },
      {
        slot_index: 1,
        video_id: 2,
        title: 'Fall 2',
        phase_type: 'training',
        duration_seconds: null,
        time_limit_seconds: null,
        entered: false,
        watch_seconds: 0,
        on_screen_seconds: 0,
        max_playhead_seconds: 0,
        play_spans: 0,
        coverage: null,
        plays: 0,
        pauses: 0,
        seeks: 0,
        replays: 0,
        completed: false,
        info_opens: 0,
        task_opens: 0,
        notes_focused: 0,
        typing_bursts: 0,
        notes: { snapshots: 0, chars: 0, last_at: null, last_video_time: null },
        diagnosis: null,
        outro_answered: false,
        ratings_answered: false,
        gaze: {
          recordings: 0,
          samples: 0,
          sampling_rate_hz: null,
          expected_samples: null,
          yield: null,
          started_at: null,
          completed_at: null,
        },
        screen: null,
      },
    ],
    questionnaires: [],
    calibrations: [],
    events_by_type: [],
    ...overrides,
  }
}

test('reads the run case by case, and says which cases were not reached', () => {
  useParticipantStats.mockReturnValue({ data: stats(), isLoading: false, isError: false })
  render(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} />)

  expect(screen.getByText('Teilnehmer P02')).toBeInTheDocument()
  // Progress reads as the fraction of the script, not a bare step number.
  expect(screen.getByText('Schritt 36/54')).toBeInTheDocument()
  expect(screen.getByText('66,7 %')).toBeInTheDocument()

  expect(screen.getByText('1. Fall 1')).toBeInTheDocument()
  expect(screen.getByText('zu Ende gesehen')).toBeInTheDocument()
  expect(screen.getByText('2. Fall 2')).toBeInTheDocument()
  expect(screen.getByText('nicht erreicht')).toBeInTheDocument()
  expect(screen.getByText(/Der Teilnehmer hat diesen Fall noch nicht geöffnet/)).toBeInTheDocument()

  // Watching time and screen time are reported apart: the gap is what they
  // spent reading and typing with the clip paused.
  expect(screen.getByText('26 s Video · 31 s am Schirm')).toBeInTheDocument()
  expect(screen.getByText(/97,1 % Ausbeute/)).toBeInTheDocument()
})

test('an empty figure reads as unknown rather than as zero', () => {
  const empty = stats()
  empty.cases[0].diagnosis = null
  empty.cases[0].gaze.recordings = 0
  useParticipantStats.mockReturnValue({ data: empty, isLoading: false, isError: false })
  render(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} />)

  expect(screen.getByText('nicht abgegeben')).toBeInTheDocument()
  expect(screen.getAllByText('nicht aufgezeichnet').length).toBeGreaterThan(0)
})

test('a failed screen capture is called out, not left blank', () => {
  const failed = stats()
  failed.cases[0].screen = {
    id: 3,
    status: 'failed',
    error: 'capture device busy',
    duration_ms: null,
    byte_size: null,
    width: null,
    height: null,
    fps: null,
    recorder: 'bridge',
  }
  useParticipantStats.mockReturnValue({ data: failed, isLoading: false, isError: false })
  render(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} />)

  expect(screen.getByText('fehlgeschlagen: capture device busy')).toBeInTheDocument()
})
