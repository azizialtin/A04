import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

import type { SessionScript, SessionStep } from '../src/api/participant'
import type { Question } from '../src/lib/questionnaire'
import { seedStudy } from './seed'

const API = process.env.E2E_API_URL ?? 'http://localhost:8031'
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e@a04.test'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-1234'
let researcherToken: string | undefined
const source = JSON.parse(readFileSync(new URL('../../backend/app/data/pretest_oct2026.json', import.meta.url), 'utf8')) as {
  ck_tasks: { source_row: number; question: Question }[]
  pck_example: { title: string; description: string; questions: Question[] }
}

async function api<T>(request: APIRequestContext, path: string, token?: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await request.fetch(API + path, {
    method, data, headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy()
  return response.json() as Promise<T>
}

async function admin(request: APIRequestContext) {
  if (!researcherToken) {
    const result = await api<{ access_token: string }>(request, '/auth/admin/login', undefined, 'POST', {
      email: EMAIL, password: PASSWORD,
    })
    researcherToken = result.access_token
  }
  return researcherToken
}

async function login(page: Page, participantId: string) {
  await page.goto('/login')
  await page.getByRole('textbox').fill(participantId)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByText(participantId, { exact: true })).toBeVisible()
  return page.evaluate(() => JSON.parse(localStorage.getItem('a04_auth')!).token as string)
}

// Research exports quote JSON and may contain embedded newlines; splitting on
// commas or lines would turn the assertions below into false positives.
function csvRecords(contents: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  const text = contents.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(field); field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += char
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const headers = rows.shift() ?? []
  return rows.filter((values) => values.some(Boolean)).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
  )
}

async function exported(request: APIRequestContext, studyId: number, participantId: string, kind: string, token: string) {
  const response = await request.get(`${API}/admin/studies/${studyId}/export/${kind}`, {
    headers: { Authorization: `Bearer ${token}` }, params: { participant_ids: participantId },
  })
  expect(response.ok(), `${kind} export: ${await response.text()}`).toBeTruthy()
  return csvRecords(await response.text())
}

async function viewportReport(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0))
  return page.evaluate(() => {
    const root = document.querySelector('.pretest-page')!
    const outside = [...root.querySelectorAll<HTMLElement>('input, textarea, button')].flatMap((control) => {
      const rect = control.getBoundingClientRect()
      if (!rect.width || !rect.height) return []
      return rect.top < -1 || rect.left < -1 || rect.bottom > innerHeight + 1 || rect.right > innerWidth + 1
        ? [control.getAttribute('aria-label') || control.getAttribute('name') || control.textContent?.trim() || control.tagName]
        : []
    })
    const scrollers = [...root.querySelectorAll<HTMLElement>('*')].flatMap((element) => {
      const style = getComputedStyle(element)
      const vertical = /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
      const horizontal = /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1
      return vertical || horizontal ? [element.className || element.tagName] : []
    })
    return {
      vertical: Math.max(0, document.documentElement.scrollHeight - innerHeight),
      horizontal: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      outside, scrollers,
    }
  })
}

test('real CK timing survives reload and supervisor finish exports only visited pages', async ({ page, request }, info) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  const token = await admin(request)
  const { studyId, participantId } = await seedStudy(EMAIL, PASSWORD)
  try {
    // Finalise the instrument before participant login snapshots the run's
    // assigned cases. No existing study or participant is rewritten.
    const defaults = await api<{ id: number; placement: string }[]>(request, `/admin/studies/${studyId}/questionnaires`, token)
    for (const questionnaire of defaults.filter((item) => item.placement === 'pre_test')) {
      await api(request, `/admin/questionnaires/${questionnaire.id}?force=true`, token, 'DELETE')
    }
    const makePage = (body: Record<string, unknown>) => api<{ id: number }>(
      request, `/admin/studies/${studyId}/questionnaires`, token, 'POST', { placement: 'pre_test', ...body },
    )
    const debug = (id: string): Question => ({
      id, type: 'debugging', text: 'Nennen Sie die Fehlerzeile und beschreiben Sie den Fehler.',
      max_entries: 5, code_blocks: [{ filename: 'Beispiel.java', code: [
        'int sum = 0;', 'for (int i = 0; i <= 3; i++) {', '    sum = i;', '}', 'System.out.println(sum);',
      ] }],
    })
    const first = await makePage({
      title: 'CK Integration 1', section: 'CK-Aufgaben', section_key: 'ck_tasks', order_index: 0,
      intro_title: 'CK-Start Integration', intro_body: 'Für diesen Abschnitt haben Sie **7 Minuten Zeit**.',
      questions: [debug('ck_first')],
    })
    const skipped = await makePage({
      title: 'CK Integration 2', section: 'CK-Aufgaben', section_key: 'ck_tasks', order_index: 1,
      questions: [debug('ck_skipped')],
    })
    const pck = await makePage({
      title: 'PCK Integration', section: 'PCK', section_key: 'pck', order_index: 2,
      intro_title: 'PCK-Start Integration', intro_body: 'Ordnen Sie die Erklärungen und begründen Sie Ihre Wahl.',
      questions: [
        { id: 'pck_rank', type: 'ranking', text: 'Ordnen Sie die Erklärungen.', options: [
          { value: 'a', label: 'Erklärung A' }, { value: 'b', label: 'Erklärung B' }, { value: 'c', label: 'Erklärung C' },
        ] },
        { id: 'pck_reason', type: 'free_text', text: 'Begründen Sie Ihre Wahl.' },
        { id: 'pck_selected', type: 'multi_select', text: 'Welche Erklärungen treffen zu?', options: [
          { value: 1, label: 'Erklärung 1 als Zahl' },
          { value: '1', label: 'Erklärung 1 als Text' },
          { value: 'other', label: 'Andere Erklärung' },
        ] },
      ],
    })
    await api(request, `/admin/studies/${studyId}`, token, 'PATCH', { texts: {
      case_intro_title: 'Allgemeine Fall-Einleitung', case_intro_body: 'Für spätere Fälle.',
      pre_test_case_intro_title: 'Vortest-Video Integration',
      pre_test_case_intro_body: 'Beobachten Sie das Vortest-Video und machen Sie sich Notizen.',
    } })

    const participantToken = await login(page, participantId)
    const session = () => api<SessionScript>(request, '/participant/session', participantToken)
    await page.getByRole('button', { name: 'Los geht’s' }).click()
    await expect(page.getByRole('heading', { name: 'CK-Start Integration', exact: true })).toBeVisible()
    expect((await session()).section_timing).toBeNull()
    await page.screenshot({ path: info.outputPath('real-ck-introduction.png') })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'CK Integration 1', exact: true })).toBeVisible()
    await expect(page.getByRole('timer')).toBeVisible()
    const initial = await session()
    const deadline = initial.section_timing!.deadline_ms
    expect(deadline - initial.section_timing!.server_now_ms).toBeGreaterThan(410_000)
    expect(deadline - initial.section_timing!.server_now_ms).toBeLessThanOrEqual(420_000)
    await page.getByRole('spinbutton').fill('3')
    await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()
    await expect(page.getByRole('timer')).not.toHaveText('7:00')
    await page.reload()
    await expect(page.getByRole('timer')).toBeVisible()
    await expect(page.getByRole('spinbutton')).toHaveValue('3')
    await expect(page.getByLabel('Was ist der Fehler?', { exact: true })).toHaveValue('')
    expect((await session()).section_timing!.deadline_ms).toBe(deadline)
    await page.screenshot({ path: info.outputPath('real-ck-partial-after-reload.png') })

    await page.keyboard.press('Control+Alt+Shift+N')
    await expect(page.getByRole('heading', { name: 'CK-Abschnitt beenden', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Speichern und zu PCK', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'PCK-Start Integration', exact: true })).toBeVisible()
    const finished = await session()
    expect(finished.section_timing).toMatchObject({ deadline_ms: deadline, finished: true })
    expect(finished.steps[finished.current_step_index]).toMatchObject({ kind: 'section_intro', section_key: 'pck' })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'PCK Integration', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Erklärung B: Nach oben verschieben', exact: true }).click()
    await page.locator('[data-aoi="question.pck_reason"] textarea').fill('Erklärung B beschreibt die Fehlvorstellung genauer.')
    await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: 'Erklärung 1 als Zahl', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Erklärung 1 als Text', exact: true }).check()
    await expect(page.getByRole('checkbox', { name: 'Erklärung 1 als Zahl', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Erklärung 1 als Text', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Andere Erklärung', exact: true })).not.toBeChecked()
    await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
    await page.screenshot({ path: info.outputPath('real-pck-ranking.png') })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Vorab-Fragebogen', exact: true })).toBeVisible()

    const responses = await exported(request, studyId, participantId, 'responses', token)
    expect(responses.map((row) => Number(row.questionnaire_id)).sort((a, b) => a - b)).toEqual([first.id, pck.id].sort((a, b) => a - b))
    expect(responses.some((row) => Number(row.questionnaire_id) === skipped.id)).toBe(false)
    const ckResponse = responses.find((row) => Number(row.questionnaire_id) === first.id)!
    expect(ckResponse.response_status).toBe('partial')
    expect(JSON.parse(ckResponse.answers)).toEqual({ ck_first: { lines: [3] } })
    const pckResponse = responses.find((row) => Number(row.questionnaire_id) === pck.id)!
    expect(pckResponse.response_status).toBe('submitted')
    expect(JSON.parse(pckResponse.answers)).toEqual({
      pck_rank: ['b', 'a', 'c'], pck_reason: 'Erklärung B beschreibt die Fehlvorstellung genauer.',
      pck_selected: [1, '1'],
    })
    const sections = await exported(request, studyId, participantId, 'sections', token)
    const ckSection = sections.find((row) => row.section_key === 'ck_tasks')!
    expect(ckSection).toMatchObject({ pages_answered: '0', visited_pages: '1', exit_reason: 'supervisor_finish', deadline_ms: String(deadline) })
    expect(Number(ckSection.started_client_ts)).toBe(initial.section_timing!.started_client_ts)
    expect(Number(ckSection.ended_client_ts)).toBeGreaterThan(Number(ckSection.started_client_ts))
    const visits = JSON.parse(ckSection.page_visits) as { questionnaire_id: number; entered_client_ts: number; exited_client_ts: number | null; exit_reason: string | null }[]
    expect(visits.length).toBeGreaterThanOrEqual(2)
    expect(visits.every((visit) => visit.questionnaire_id === first.id)).toBe(true)
    expect(visits.some((visit) => visit.exit_reason === 'supervisor_finish' && visit.exited_client_ts! >= visit.entered_client_ts)).toBe(true)
    const pckSection = sections.find((row) => row.section_key === 'pck')!
    expect(pckSection).toMatchObject({ pages_answered: '1', visited_pages: '1' })
    expect(JSON.parse(pckSection.page_visits)).toEqual([expect.objectContaining({ questionnaire_id: pck.id, exit_reason: 'submitted' })])
    await info.attach('responses-export.json', { body: JSON.stringify(responses, null, 2), contentType: 'application/json' })
    await info.attach('sections-export.json', { body: JSON.stringify(sections, null, 2), contentType: 'application/json' })

    const after = await session()
    const videoIntro = after.steps.find((step) => step.kind === 'case_intro' && step.phase_type === 'pre_test')!
    await api(request, '/participant/session/progress', participantToken, 'PATCH', {
      current_step_index: videoIntro.index, expected_step_index: after.current_step_index, client_ts: Date.now(),
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Vortest-Video Integration', exact: true })).toBeVisible()
    await expect(page.getByText('Beobachten Sie das Vortest-Video und machen Sie sich Notizen.', { exact: true })).toBeVisible()
    await expect(page.getByText('Für spätere Fälle.', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('real-pretest-video-introduction.png') })
  } finally {
    await page.close()
    await api(request, `/admin/studies/${studyId}?force=true`, token, 'DELETE')
  }
})

test('every default pretest page fits the lab viewport, including conditional demographic fields', async ({ page, request }, info) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  const token = await admin(request)
  const study = await api<{ id: number }>(request, '/admin/studies', token, 'POST', { name: 'E2E default pretest viewport ' + Date.now() })
  const participantId = 'E2E-VIEW-' + Date.now()
  try {
    await api(request, `/admin/studies/${study.id}/participants`, token, 'POST', { ids: [participantId] })
    const participantToken = await login(page, participantId)
    const initial = await api<SessionScript>(request, '/participant/session', participantToken)
    const pages = initial.steps.filter((step): step is Extract<SessionStep, { kind: 'questionnaire' }> =>
      step.kind === 'questionnaire' && step.placement === 'pre_test',
    )
    expect(pages).toHaveLength(24)
    expect(pages.slice(3, 16).map((step) => step.questions[0].id)).toEqual(source.ck_tasks.map((task) => task.question.id))
    expect(pages.slice(3, 16).every((step) => step.section_key === 'ck_tasks')).toBe(true)
    expect(pages[16].section_key).toBe('pck')
    expect(pages[16].questions.map((question) => question.id)).toEqual(source.pck_example.questions.map((question) => question.id))
    expect(source.ck_tasks.find((task) => task.source_row === 25)?.question.id).toBe('ck_pre_08')
    expect(source.ck_tasks.find((task) => task.source_row === 26)?.question.id).toBe('ck_pre_10')
    const reports = []
    let current = initial.current_step_index
    for (const step of pages) {
      await api(request, '/participant/session/progress', participantToken, 'PATCH', {
        current_step_index: step.index, expected_step_index: current, client_ts: Date.now(),
      })
      current = step.index
      await page.reload()
      await expect(page.getByRole('heading', { name: step.title, exact: true })).toBeVisible()
      // Choose the branch that exposes each conditional field, using the
      // instrument's own option values rather than translated label guesses.
      for (const [id, value] of Object.entries({
        participant_group: 1, st_enrollment: 1, st_schulform: 7, teach_inf_ex: 1, teach_prog_ex: 1, java_ex: 1,
      })) {
        const question = step.questions.find((item) => item.id === id)
        if (!question) continue
        const option = question.options?.findIndex((item) => typeof item !== 'string' && item.value === value) ?? -1
        expect(option, `missing branch ${id}=${value}`).toBeGreaterThanOrEqual(0)
        await page.locator(`[data-aoi="question.${id}"] input[type="radio"]`).nth(option).check()
      }
      for (const question of step.questions.filter((item) => item.show_if)) {
        await expect(page.locator(`[data-aoi="question.${question.id}"]`)).toBeVisible()
      }
      for (const question of step.questions.filter((item) => item.type === 'debugging')) {
        const fields = page.locator(`[data-aoi="question.${question.id}"]`)
        const add = fields.getByRole('button', { name: /Fehler bezieht sich/ })
        for (let count = 1; count < 5; count++) await add.click()
        await expect(fields.getByRole('spinbutton')).toHaveCount(5)
        await expect(add).toBeDisabled()
        for (const input of await fields.getByRole('spinbutton').all()) await input.fill('1')
        await fields.getByLabel('Was ist der Fehler?', { exact: true }).fill('Begründung für die Browserprüfung.')
        await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
      }
      if (step.section_key === 'pck') {
        for (const textarea of await page.locator('textarea').all()) await textarea.fill('Antwort zur Unterrichtssituation.')
        await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()
        await page.getByRole('button', { name: 'Diese Reihenfolge übernehmen', exact: true }).click()
        const ranking = step.questions.find((question) => question.type === 'ranking')!
        const second = ranking.options![1]
        const secondLabel = typeof second === 'string' ? second : second.label
        await page.getByRole('button', { name: secondLabel + ': Nach oben verschieben', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
      }
      await page.evaluate(() => document.fonts.ready)
      const report = { title: step.title, questionnaire_id: step.questionnaire_id, ...await viewportReport(page) }
      reports.push(report)
      await page.screenshot({ path: info.outputPath('default-pretest-' + step.page + '.png'), fullPage: true })
    }
    await info.attach('default-pretest-viewport.json', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' })
    expect(reports.filter((report) => report.vertical > 1 || report.horizontal > 1 || report.outside.length || report.scrollers.length),
      'Each default page must show its content and controls without viewport or nested scrolling at 1920×1080. See per-page screenshots and viewport report.',
    ).toEqual([])
  } finally {
    await page.close()
    await api(request, `/admin/studies/${study.id}?force=true`, token, 'DELETE')
  }
})
