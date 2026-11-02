import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import type { ParticipantStats, ParticipantTimedSection } from '../../api/admin'
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
    sections: [],
    timed_sections: [],
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

test('adds the time up per section, and the pre-test as a whole', () => {
  const timed = stats({
    sections: [
      { section: 'Demographics', pages: 1, seconds: 165, pre_test: true },
      { section: 'CK-Pretest', pages: 2, seconds: 188, pre_test: true },
      { section: 'Nach dem Fall', pages: 9, seconds: 240, pre_test: false },
    ],
  })
  useParticipantStats.mockReturnValue({ data: timed, isLoading: false, isError: false })
  render(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} />)

  expect(screen.getByText('2:45 min · 1 Seite')).toBeInTheDocument()
  expect(screen.getByText('3:08 min · 2 Seiten')).toBeInTheDocument()
  expect(screen.getByText('4:00 min · 9 Seiten')).toBeInTheDocument()
  // 165 + 188, the per-case battery left out.
  expect(screen.getByText('5:53 min')).toBeInTheDocument()
  expect(screen.getByText(/Summierte Antwortzeiten:/)).toBeInTheDocument()
  expect(screen.getByText('Keine Abschnittszeitmessung erfasst.')).toBeInTheDocument()
})

function timedSection(overrides: Partial<ParticipantTimedSection> = {}): ParticipantTimedSection {
  const start = Date.parse('2026-11-02T09:00:00Z')
  return {
    section_key: 'ck_tasks',
    section: 'CK-Aufgaben',
    started_client_ts: start,
    ended_client_ts: start + 425_000,
    deadline_ms: start + 420_000,
    elapsed_seconds: 425,
    deadline_overrun_seconds: 5,
    exit_reason: 'supervisor_finish',
    visited_pages: 1,
    page_visits: [
      {
        visit_id: 'partial',
        questionnaire_id: 4,
        title: 'CK 1',
        step_index: 5,
        entered_client_ts: start,
        exited_client_ts: start + 425_000,
        elapsed_seconds: 425,
        exit_reason: 'supervisor_finish',
        is_review: false,
        submitted_answers: { ck_01: { lines: [3], explanation: 'Originaler Teilstand' } },
      },
      {
        visit_id: 'review',
        questionnaire_id: 4,
        title: 'CK 1',
        step_index: 5,
        entered_client_ts: start + 900_000,
        exited_client_ts: start + 930_000,
        elapsed_seconds: 30,
        exit_reason: 'submitted',
        is_review: true,
        submitted_answers: { ck_01: { lines: [4], explanation: 'Spätere Überarbeitung' } },
      },
      {
        visit_id: 'lost-exit',
        questionnaire_id: 4,
        title: 'CK 1',
        step_index: 5,
        entered_client_ts: start + 960_000,
        exited_client_ts: null,
        elapsed_seconds: null,
        exit_reason: null,
        is_review: true,
        submitted_answers: null,
      },
    ],
    ...overrides,
  }
}

test('distinguishes elapsed CK time, partial answers and immutable review snapshots', async () => {
  const user = userEvent.setup()
  const section = timedSection()
  useParticipantStats.mockReturnValue({
    data: stats({
      timed_sections: [section],
      sections: [{ section: 'CK-Aufgaben', pages: 1, seconds: 30, pre_test: true }],
      questionnaires: [
        {
          id: 4,
          response_id: 10,
          title: 'CK 1',
          placement: 'pre_test',
          section: 'CK-Aufgaben',
          video_id: null,
          video_title: null,
          questions: 1,
          answered: 1,
          response_status: 'partial',
          seconds: 30,
          created_at: '2026-11-02T09:00:00Z',
        },
      ],
    }),
    isLoading: false,
    isError: false,
  })
  render(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} />)

  const timing = screen.getByRole('region', { name: 'Zeitmessung CK-Aufgaben' })
  expect(within(timing).getByText('Durch Betreuung beendet')).toBeInTheDocument()
  expect(within(timing).getByText('Dauer (Beginn bis Ende)').nextElementSibling).toHaveTextContent(
    '7:05 min',
  )
  expect(within(timing).getByText('5 s')).toBeVisible()
  expect(within(timing).getByText('Timer-Ende (Serverzeit)')).toBeInTheDocument()
  expect(screen.getByText('30 s · 1 Seite')).toBeInTheDocument()
  expect(screen.getByText('Teilantwort')).toBeInTheDocument()

  await user.click(within(timing).getByText('Seitenbesuche (3)'))
  const visits = within(timing).getByRole('table', { name: 'Seitenbesuche CK-Aufgaben' })
  const rows = within(visits).getAllByRole('row')
  expect(within(rows[1]).getByText('Teilantwort gespeichert')).toBeVisible()
  expect(within(rows[2]).getByText('Überarbeitung')).toBeVisible()
  expect(within(rows[3]).getByText('Kein Austritt erfasst')).toBeVisible()
  expect(within(rows[3]).getAllByText('—')).toHaveLength(2)
  expect(within(rows[3]).getByText('Kein Antwortstand erfasst')).toBeVisible()

  await user.click(within(rows[1]).getByText('Antwortstand anzeigen'))
  await user.click(within(rows[2]).getByText('Antwortstand anzeigen'))
  expect(within(rows[1]).getByText(/Zeilen: 3.*Erklärung: Originaler Teilstand/s)).toBeVisible()
  expect(within(rows[2]).getByText(/Zeilen: 4.*Erklärung: Spätere Überarbeitung/s)).toBeVisible()
})

test('keeps absent timing and an empty saved answer distinct from zero and missing snapshots', async () => {
  const user = userEvent.setup()
  const section = timedSection({
    ended_client_ts: null,
    elapsed_seconds: null,
    deadline_overrun_seconds: null,
    exit_reason: null,
    page_visits: [],
  })
  useParticipantStats.mockReturnValue({
    data: stats({ timed_sections: [section] }),
    isLoading: false,
    isError: false,
  })
  const { rerender } = render(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} />)

  const timing = screen.getByRole('region', { name: 'Zeitmessung CK-Aufgaben' })
  expect(within(timing).getByText('Kein Ende erfasst')).toBeInTheDocument()
  expect(within(timing).getAllByText('—')).toHaveLength(3)
  expect(within(timing).queryByText('0 s')).not.toBeInTheDocument()

  section.page_visits = [{ ...timedSection().page_visits[0], submitted_answers: {} }]
  rerender(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} />)
  await user.click(within(timing).getByText('Seitenbesuche (1)'))
  await user.click(within(timing).getByText('Antwortstand anzeigen'))
  expect(within(timing).getByText('Leerer Antwortstand')).toBeVisible()
  expect(within(timing).queryByText('Kein Antwortstand erfasst')).not.toBeInTheDocument()
})

test('reveals the first loaded result without stealing focus again on refresh', () => {
  const onReady = vi.fn()
  const onClose = vi.fn()
  useParticipantStats.mockReturnValue({ isLoading: true, isError: false })
  const { rerender } = render(
    <ParticipantStatsPanel participantId="P02" onClose={onClose} onReady={onReady} />,
  )
  expect(onReady).not.toHaveBeenCalled()

  useParticipantStats.mockReturnValue({ data: stats(), isLoading: false, isError: false })
  rerender(<ParticipantStatsPanel participantId="P02" onClose={onClose} onReady={onReady} />)
  expect(onReady).toHaveBeenCalledOnce()

  useParticipantStats.mockReturnValue({ data: stats(), isLoading: false, isFetching: true })
  rerender(<ParticipantStatsPanel participantId="P02" onClose={onClose} onReady={onReady} />)
  useParticipantStats.mockReturnValue({ data: stats(), isLoading: false, isFetching: false })
  rerender(<ParticipantStatsPanel participantId="P02" onClose={onClose} onReady={onReady} />)
  expect(onReady).toHaveBeenCalledOnce()

  useParticipantStats.mockReturnValue({ isLoading: true, isError: false })
  rerender(<ParticipantStatsPanel participantId="P03" onClose={onClose} onReady={onReady} />)
  useParticipantStats.mockReturnValue({
    data: stats({ id: 'P03' }),
    isLoading: false,
    isError: false,
  })
  rerender(<ParticipantStatsPanel participantId="P03" onClose={onClose} onReady={onReady} />)
  expect(onReady).toHaveBeenCalledTimes(2)
})

test('cached participant data needs no second reveal', () => {
  const onReady = vi.fn()
  useParticipantStats.mockReturnValue({ data: stats(), isLoading: false, isError: false })
  render(<ParticipantStatsPanel participantId="P02" onClose={vi.fn()} onReady={onReady} />)
  expect(onReady).not.toHaveBeenCalled()
})
