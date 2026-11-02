import { expect, test, type Page } from '@playwright/test'

import type { AdminVideo, Study } from '../src/api/admin'

const API = 'http://a04.invalid'
const participantId = 'TEST-CK-TIMING'
const start = Date.UTC(2026, 10, 2, 9)

async function setup(page: Page) {
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.addInitScript(() => {
    const payload = { sub: 'TEST-ADMIN', role: 'admin', exp: 4_000_000_000 }
    localStorage.setItem(
      'a04_auth',
      JSON.stringify({ token: `e30.${btoa(JSON.stringify(payload))}.test` }),
    )
    localStorage.setItem('i18nextLng', 'de')
  })
  const study: Study = {
    id: 8,
    name: 'Admin-Feedbackprüfung',
    description: '',
    is_active: true,
    sosci_pretest_url: '',
    sosci_posttest_url: '',
    sosci_id_param: 'id',
    think_aloud_batch_size: 1,
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
    video_defaults: {
      time_limit_seconds: 420,
      task_description: 'Gemeinsame Aufgabe',
      info_text: 'Gemeinsame Information',
    },
  }
  const state = {
    study,
    video: {
      id: 13,
      study_id: 8,
      title: 'Bestehender Fall',
      phase_type: 'training',
      has_file: true,
      task_description: 'Schau Dir Bitte das Video an, mache notizen',
      info_text: 'Unterrichts entscheidungen',
      student_task_text: 'Erklären Sie die Schleife.',
      time_limit_seconds: 180,
      use_default_task: false,
      use_default_info: false,
    } satisfies AdminVideo,
    patches: [] as Record<string, unknown>[],
    failNext: false,
    unexpected: [] as string[],
  }
  const visits = [
    {
      visit_id: 'original',
      questionnaire_id: 101,
      title: 'CK: Aufgabe 1',
      step_index: 5,
      entered_client_ts: start,
      exited_client_ts: start + 450_000,
      elapsed_seconds: 450,
      exit_reason: 'supervisor_finish',
      is_review: false,
      submitted_answers: { ck_pre_01: { lines: [3], explanation: '' } },
    },
    {
      visit_id: 'review',
      questionnaire_id: 101,
      title: 'CK: Aufgabe 1',
      step_index: 5,
      entered_client_ts: start + 600_000,
      exited_client_ts: start + 620_000,
      elapsed_seconds: 20,
      exit_reason: 'submitted',
      is_review: true,
      submitted_answers: { ck_pre_01: { lines: [3], explanation: 'Überarbeitete Begründung' } },
    },
    {
      visit_id: 'abandoned-review',
      questionnaire_id: 101,
      title: 'CK: Aufgabe 1',
      step_index: 5,
      entered_client_ts: start + 650_000,
      exited_client_ts: null,
      elapsed_seconds: null,
      exit_reason: null,
      is_review: true,
      submitted_answers: null,
    },
  ]
  const stats = {
    generated_at: new Date(start + 700_000).toISOString(),
    id: participantId,
    study_id: 8,
    study_name: study.name,
    status: 'active',
    created_at: null,
    session: {
      started_at: new Date(start).toISOString(),
      completed_at: null,
      minutes: null,
      step: 6,
      total_steps: 30,
      progress: 20,
      current_step: 'questionnaire',
      assigned_sequence: false,
      video_set: null,
    },
    activity: { events: 3, first_at: null, last_at: null, minutes: null },
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
      responses: 1,
      gaze_samples: 0,
      screens_stored: 0,
      screens_failed: 0,
      screen_bytes: 0,
    },
    cases: [],
    questionnaires: [
      {
        id: 101,
        response_id: 1,
        title: 'CK: Aufgabe 1',
        placement: 'pre_test',
        section: 'CK-Aufgaben',
        video_id: null,
        video_title: null,
        questions: 1,
        answered: 1,
        seconds: 20,
        created_at: new Date(start + 620_000).toISOString(),
        response_status: 'submitted',
      },
    ],
    sections: [{ section: 'CK-Aufgaben', pages: 1, seconds: 20, pre_test: true }],
    timed_sections: [
      {
        section_key: 'ck_tasks',
        section: 'CK-Aufgaben',
        started_client_ts: start,
        ended_client_ts: start + 450_000,
        deadline_ms: start + 420_000,
        elapsed_seconds: 450,
        deadline_overrun_seconds: 30,
        exit_reason: 'supervisor_finish',
        visited_pages: 1,
        page_visits: visits,
      },
    ],
    calibrations: [],
    events_by_type: [],
  }
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    }
    const json = (body: unknown) => route.fulfill({ headers, json: body })
    if (request.method() === 'OPTIONS') return route.fulfill({ headers, status: 204 })
    if (path === '/admin/studies/8') return json(state.study)
    if (path === '/admin/studies/8/videos') return json([state.video])
    if (path === '/admin/studies/8/participants') {
      return json([
        {
          id: participantId,
          status: 'active',
          slot_count: 0,
          video_set_id: null,
          video_set_name: null,
        },
      ])
    }
    if (path === `/admin/participants/${participantId}/stats`) return json(stats)
    if (path === '/admin/videos/13' && request.method() === 'PATCH') {
      const patch = request.postDataJSON() as Record<string, unknown>
      state.patches.push(patch)
      if (state.failNext) {
        state.failNext = false
        return route.fulfill({
          headers,
          status: 503,
          json: { detail: 'Speicher vorübergehend nicht erreichbar.' },
        })
      }
      state.video = { ...state.video, ...patch }
      return json(state.video)
    }
    state.unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ headers, status: 404, json: { detail: path } })
  })
  return state
}

test('existing video wording survives save failure, reload and default toggles', async ({
  page,
}, info) => {
  const state = await setup(page)
  await page.goto('/admin/studies/8?tab=videos')
  await page.getByRole('button', { name: 'Video „Bestehender Fall“ bearbeiten' }).click()
  const dialog = page.getByRole('dialog', { name: 'Video bearbeiten' })
  await expect(dialog.getByLabel('Aufgabe (Task)', { exact: true })).toHaveValue(
    state.video.task_description,
  )
  await dialog
    .getByLabel('Aufgabe (Task)', { exact: true })
    .fill('Schauen Sie bitte das Video an und machen Sie Notizen.')
  await dialog.getByLabel('Info-Text', { exact: true }).fill('Unterrichtsentscheidungen')
  const defaults = dialog.getByRole('checkbox', { name: 'Standardtext der Studie verwenden' })
  await defaults.first().check()
  await expect(dialog.getByLabel('Aufgabe (Task)', { exact: true })).toHaveValue(
    'Gemeinsame Aufgabe',
  )
  await defaults.first().uncheck()
  await expect(dialog.getByLabel('Aufgabe (Task)', { exact: true })).toHaveValue(
    'Schauen Sie bitte das Video an und machen Sie Notizen.',
  )
  await dialog.getByLabel('Zeitlimit (Sekunden, leer = kein Timer)').fill('240')
  state.failNext = true
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(/Ihre Eingaben bleiben erhalten/)
  await expect(dialog.getByLabel('Info-Text', { exact: true })).toHaveValue(
    'Unterrichtsentscheidungen',
  )
  await page.screenshot({ path: info.outputPath('video-edit-retry.png') })
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.patches).toHaveLength(2)
  expect(state.patches[1]).toMatchObject({
    task_description: 'Schauen Sie bitte das Video an und machen Sie Notizen.',
    info_text: 'Unterrichtsentscheidungen',
    time_limit_seconds: 240,
  })
  expect(state.patches[1]).not.toHaveProperty('phase_type')
  expect(state.video).toMatchObject({ id: 13, phase_type: 'training', has_file: true })
  await page.reload()
  await page.getByRole('button', { name: 'Video „Bestehender Fall“ bearbeiten' }).click()
  await expect(dialog.getByLabel('Info-Text', { exact: true })).toHaveValue(
    'Unterrichtsentscheidungen',
  )
  await dialog.getByLabel('Info-Text', { exact: true }).fill('Nicht speichern')
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click()
  expect(state.patches).toHaveLength(2)
  expect(state.video.info_text).toBe('Unterrichtsentscheidungen')
  expect(state.unexpected).toEqual([])
})

test('CK statistics distinguish elapsed time, partial answers, reviews and unobserved exits', async ({
  page,
}, info) => {
  const state = await setup(page)
  await page.goto('/admin/studies/8?tab=participants')
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: participantId, exact: true }) })
  await row.getByRole('button', { name: 'Statistik', exact: true }).click()
  await expect(page.getByText(/^Summierte Antwortzeiten:/)).toBeVisible()
  const timing = page.getByRole('heading', { name: 'Abschnittszeiten', exact: true })
  await expect(timing).toBeVisible()
  await expect(page.getByRole('definition').filter({ hasText: /^7:30 min$/ })).toBeVisible()
  await expect(page.getByText('30 s', { exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Abgegeben', exact: true })).toBeVisible()
  await page.getByText('Seitenbesuche (3)', { exact: true }).click()
  await expect(page.getByText('Teilantwort gespeichert', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Überarbeitung', exact: true }).first()).toBeVisible()
  await expect(page.getByText('Kein Austritt erfasst', { exact: true })).toBeVisible()
  const originalVisit = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: 'Erstbearbeitung', exact: true }),
  })
  await originalVisit.getByText('Antwortstand anzeigen', { exact: true }).click()
  await expect(originalVisit.getByText('ck_pre_01', { exact: true })).toBeVisible()
  await expect(originalVisit.getByText(/Zeilen: 3/)).toBeVisible()
  await timing.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('ck-timing-visits.png'), fullPage: true })
  expect(state.unexpected).toEqual([])
})
