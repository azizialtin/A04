import { expect, test, type Page } from '@playwright/test'

import type { ParticipantStats, RosterRow, Study, StudyStats } from '../src/api/admin'

const API = 'http://a04.invalid'
const participantId = 'TEST-P001'

function rosterRow(index: number): RosterRow {
  return {
    id: `TEST-P${String(index + 1).padStart(3, '0')}`,
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

const study: Study = {
  id: 8,
  name: 'Statistik-Browserprüfung',
  description: '',
  sosci_pretest_url: '',
  sosci_posttest_url: '',
  sosci_id_param: 'id',
  is_active: true,
  texts: {
    welcome_title: '',
    welcome_intro: '',
    welcome_steps: [],
    welcome_note: '',
    case_intro_title: '',
    case_intro_body: '',
    case_outro_title: '',
    case_outro_body: '',
    think_aloud_title: '',
    think_aloud_body: '',
  },
  video_defaults: { time_limit_seconds: null, task_description: '', info_text: '' },
  think_aloud_batch_size: 1,
}

const stats: StudyStats = {
  generated_at: '2026-10-19T10:00:00Z',
  study: { ...study, created_at: null },
  participants: {
    total: 120,
    registered: 120,
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
    never_started: 120,
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
  roster: Array.from({ length: 120 }, (_, index) => rosterRow(index)),
  activity: [],
  events_by_type: [],
}

const participant: ParticipantStats = {
  generated_at: stats.generated_at,
  id: participantId,
  study_id: study.id,
  study_name: study.name,
  status: 'registered',
  created_at: null,
  session: {
    started_at: null,
    completed_at: null,
    minutes: null,
    step: 0,
    total_steps: 54,
    progress: 0,
    current_step: null,
    assigned_sequence: false,
    video_set: null,
  },
  activity: { events: 0, first_at: null, last_at: null, minutes: null },
  totals: {
    cases: 0,
    cases_entered: 0,
    cases_completed: 0,
    watch_seconds: 0,
    on_screen_seconds: 0,
    notes: 0,
    note_chars: 0,
    diagnoses: 0,
    diagnosis_words: 0,
    responses: 0,
    gaze_samples: 0,
    screens_stored: 0,
    screens_failed: 0,
    screen_bytes: 0,
  },
  cases: [],
  questionnaires: [],
  sections: [],
  calibrations: [],
  events_by_type: [],
}

async function admin(page: Page) {
  const unexpected: string[] = []
  await page.addInitScript(() => {
    const payload = { sub: 'TEST-ADMIN', role: 'admin', exp: 4_000_000_000 }
    const token = `e30.${btoa(JSON.stringify(payload))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
  })
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (request.method() === 'GET') {
      if (path === '/admin/studies/8') return route.fulfill({ json: study, headers })
      if (path === '/admin/studies/8/stats') return route.fulfill({ json: stats, headers })
      if (path === `/admin/participants/${participantId}/stats`) {
        return route.fulfill({ json: participant, headers })
      }
    }
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 400, json: { detail: 'Unexpected test request' }, headers })
  })
  return unexpected
}

test('Details reveals the panel below a long roster and closing returns to its row', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const unexpected = await admin(page)
  await page.goto('/admin/studies/8?tab=stats')
  await expect(page.getByRole('heading', { name: study.name })).toBeVisible()

  const firstRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: /^TEST-P001\b/ }) })
  const trigger = firstRow.getByRole('button', { name: 'Details', exact: true })
  await trigger.scrollIntoViewIfNeeded()
  await expect(trigger).toBeInViewport()
  await expect(page.getByRole('cell', { name: /^TEST-P120\b/ })).not.toBeInViewport()

  await trigger.click()

  const panel = page.getByRole('region', { name: `Details für ${participantId}` })
  const heading = panel.getByRole('heading', { name: `Teilnehmer ${participantId}`, exact: true })
  await expect(panel).toBeFocused()
  await expect(heading).toBeInViewport()
  await expect(trigger).not.toBeInViewport()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await page.screenshot({ path: info.outputPath('stats-details-open.png') })

  // Returning to the roster and selecting the same row must reveal it again.
  await trigger.scrollIntoViewIfNeeded()
  await trigger.focus()
  await trigger.press('Enter')
  await expect(panel).toBeFocused()
  await expect(heading).toBeInViewport()

  await panel.getByRole('button', { name: 'Schließen', exact: true }).click()

  await expect(panel).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(trigger).toBeInViewport()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await page.screenshot({ path: info.outputPath('stats-details-closed.png') })
  expect(unexpected).toEqual([])
})
