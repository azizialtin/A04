import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { SessionScript, SessionStep } from '../src/api/participant'
import type { Question } from '../src/lib/questionnaire'
import { completeSosci } from './sosci'

const de = JSON.parse(
  readFileSync(new URL('../src/i18n/locales/de.json', import.meta.url), 'utf8'),
) as { pilot: { text_pages: Record<string, { title: string; body: string }> } }

const API = process.env.E2E_API_URL ?? 'http://localhost:8031'
test.use({ actionTimeout: 15_000 })
const headers = (token: string) => ({ Authorization: `Bearer ${token}` })

async function api<T>(
  request: APIRequestContext,
  path: string,
  token = '',
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(API + path, {
    method,
    data,
    headers: token ? headers(token) : undefined,
  })
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy()
  return response.status() === 204 ? (undefined as T) : response.json()
}

async function seed(request: APIRequestContext) {
  const { access_token: token } = await api<{ access_token: string }>(
    request,
    '/auth/admin/login',
    '',
    'POST',
    {
      email: process.env.E2E_ADMIN_EMAIL ?? 'e2e@a04.test',
      password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-1234',
    },
  )
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const study = await api<{ id: number; flow_version: string; think_aloud_count: number }>(
    request,
    '/admin/studies',
    token,
    'POST',
    {
      name: `Pilot integration ${stamp}`,
      sosci_pretest_url: 'https://sosci.example/pre',
      sosci_posttest_url: 'https://sosci.example/post',
    },
  )
  expect(study.flow_version).toBe('pilot_20261116')
  expect(study.think_aloud_count).toBe(3)
  const clip = readFileSync(new URL('./fixtures/stimulus.webm', import.meta.url))
  for (const [index, phase] of [
    'pre_test',
    ...Array<string>(5).fill('training'),
    'post_test',
  ].entries()) {
    const response = await request.post(`${API}/admin/studies/${study.id}/videos`, {
      headers: headers(token),
      multipart: {
        title: `PRIVATE_CONDITION_A_${index}`,
        phase_type: phase,
        task_description: 'Beobachten Sie die Debugging-Situation.',
        info_text: 'Diagnose bedeutet, die Situation zu erklären.',
        student_task_text:
          'Nutzen Sie die Klasse `Heizung`.\n\n```java\nclass Heizung {\n}\n```\n\n```java\nclass SmartHome {\n}\n```',
        file: { name: 'stimulus.webm', mimeType: 'video/webm', buffer: clip },
      },
    })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  const participantId = `PILOT-${stamp}`
  await api(request, `/admin/studies/${study.id}/participants`, token, 'POST', {
    ids: [participantId],
  })
  return { token, studyId: study.id, participantId }
}

async function login(page: Page, participantId: string) {
  await page.goto('/login')
  await page.getByLabel('Teilnehmer-ID').fill(participantId)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByText(participantId, { exact: true })).toBeVisible()
  return page.evaluate(() => JSON.parse(localStorage.getItem('a04_auth')!).token as string)
}

async function fillQuestions(page: Page, questions: Question[]) {
  for (const question of questions) {
    const field = page.locator(`[data-aoi="question.${question.id}"]`)
    if (!(await field.isVisible())) continue
    switch (question.type) {
      case 'multiple_choice':
      case 'likert':
        await field.getByRole('radio').first().check()
        break
      case 'multi_select': {
        const boxes = field.getByRole('checkbox')
        for (let index = 0; index < (question.min_selections ?? 1); index++)
          await boxes.nth(index).check()
        if (question.max_selections === 2) {
          expect(await boxes.count()).toBe(4)
          await expect(boxes.nth(2)).toBeDisabled()
        }
        break
      }
      case 'number':
        await field
          .getByRole('spinbutton')
          .fill(String(Math.max(question.min ?? 0, Math.min(question.max ?? 25, 25))))
        break
      case 'free_text':
        await field
          .getByRole('textbox')
          .fill('Die Beobachtung wird anhand der beschriebenen Situation begründet.')
        break
      case 'slider':
        await field.getByRole('slider').press('ArrowRight')
        break
      case 'debugging':
        await field.getByRole('spinbutton').first().fill('1')
        await field
          .getByRole('textbox')
          .fill('Die Bedingung berücksichtigt den Grenzwert nicht korrekt.')
        break
      case 'ranking':
        await field
          .getByRole('button', { name: 'Diese Reihenfolge übernehmen', exact: true })
          .click()
        break
      default:
        throw new Error(`Unhandled pilot control ${question.type}`)
    }
  }
}

function pageKey(step: SessionStep) {
  if (step.kind === 'questionnaire') return `questionnaire:${step.section_key}:${step.title}`
  if (step.kind === 'section_intro') return `intro:${step.section_key}`
  if (step.kind === 'text_page') return `text:${step.key}`
  if (step.kind === 'sosci') return `sosci:${step.variant}`
  if ('video_id' in step) return `${step.kind}:${step.case_number}`
  return step.kind
}

function csvRecords(contents: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = [],
    field = '',
    quoted = false
  const text = contents.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"'
        index++
      } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const names = rows.shift() ?? []
  return rows
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(names.map((name, index) => [name, values[index] ?? ''])))
}

test('pilot admin settings and all six text pages survive reload and reach the participant', async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const { token, studyId, participantId } = await seed(request)
  await page.addInitScript((adminToken) => {
    localStorage.setItem('a04_auth', JSON.stringify({ token: adminToken }))
    localStorage.setItem('i18nextLng', 'de')
  }, token)
  await page.goto(`/admin/studies/${studyId}?tab=details`)
  const thinking = page.getByRole('region', { name: 'Lautes Denken', exact: true })
  const bundled = thinking.getByRole('radio', { name: /Gebündelt nach dem Nachtest/ })
  await expect(bundled).toBeChecked()
  await expect(thinking.getByRole('spinbutton')).toHaveValue('3')
  await expect(thinking.getByRole('listitem')).toHaveText([
    'Trainingsfall 4',
    'Trainingsfall 5',
    'Nachtestfall',
  ])
  await thinking.getByRole('radio', { name: /Blockweise während des Trainings/ }).check()
  await thinking.getByRole('spinbutton').fill('2')
  await thinking.getByRole('button', { name: 'Speichern', exact: true }).click()
  const study = () =>
    api<{
      think_aloud_mode: string
      think_aloud_count: number
      think_aloud_batch_size: number
      texts: Record<string, string>
    }>(request, `/admin/studies/${studyId}`, token)
  await expect.poll(async () => (await study()).think_aloud_batch_size).toBe(2)
  await page.reload()
  await expect(
    thinking.getByRole('radio', { name: /Blockweise während des Trainings/ }),
  ).toBeChecked()
  await bundled.check()
  await expect(thinking.getByRole('spinbutton')).toHaveValue('3')
  await thinking.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect.poll(async () => (await study()).think_aloud_mode).toBe('bundled')
  await thinking.screenshot({ path: info.outputPath('admin-think-aloud.png') })

  const expected: Record<string, string> = {}
  for (const [key, source] of Object.entries(de.pilot.text_pages)) {
    const label = key === 'post_intro' ? 'Vor dem Abschlussfragebogen' : source.title
    expected[`${key}_title`] = `Pilot: ${label}`
    expected[`${key}_body`] = `Individueller Text für ${key}.\n\nZweiter Absatz.`
    await page.getByLabel(`Überschrift: ${label}`, { exact: true }).fill(expected[`${key}_title`])
    await page.getByLabel(`Text: ${label}`, { exact: true }).fill(expected[`${key}_body`])
  }
  const texts = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: 'Texte für Teilnehmer', exact: true }) })
  await expect(texts.getByText(/Der Ablauf/)).toHaveCount(0)
  await texts.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect
    .poll(async () => (await study()).texts.post_intro_body)
    .toBe(expected.post_intro_body)
  await page.reload()
  for (const [key, source] of Object.entries(de.pilot.text_pages)) {
    const label = key === 'post_intro' ? 'Vor dem Abschlussfragebogen' : source.title
    await expect(page.getByLabel(`Text: ${label}`, { exact: true })).toHaveValue(
      expected[`${key}_body`],
    )
  }
  await page.getByRole('button', { name: 'Fragebögen', exact: true }).click()
  const table = page.getByRole('table', { name: 'Alle Fragebogenseiten', exact: true })
  await expect(table.getByRole('columnheader', { name: 'Reihenfolge', exact: true })).toBeVisible()
  await expect(page.getByText(/Unter diesem Namen werden die Bearbeitungszeiten/)).toContainText(
    'steuert nicht den Fortschrittsbalken',
  )
  await expect(page.getByLabel('Abschnittsfunktion').locator('option[value="mesp"]')).toHaveText(
    'mesp_pre · MESP',
  )
  await table.screenshot({ path: info.outputPath('admin-questionnaire-order.png') })

  const { access_token } = await api<{ access_token: string }>(
    request,
    '/auth/participant/login',
    '',
    'POST',
    { participant_id: participantId },
  )
  const script = await api<SessionScript>(request, '/participant/session', access_token)
  const textSteps = script.steps.filter((step) => step.kind === 'text_page')
  expect(textSteps).toHaveLength(6)
  for (const step of textSteps) {
    expect(step.title).toBe(expected[`${step.key}_title`])
    expect(step.body).toBe(expected[`${step.key}_body`])
  }
  expect(script.steps.filter((step) => step.kind === 'think_aloud')).toHaveLength(3)
})

test('pilot completes all pages with seven cases, three replays, skips and MESP exports', async ({
  page,
  request,
}, info) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  const { token, studyId, participantId } = await seed(request)
  const participantToken = await login(page, participantId)
  const getSession = () => api<SessionScript>(request, '/participant/session', participantToken)
  const initial = await getSession()
  expect(initial.flow_version).toBe('pilot_20261116')
  expect(initial.steps).toHaveLength(69)
  expect(JSON.stringify(initial)).not.toContain('PRIVATE_CONDITION')
  expect(
    initial.steps.filter((step) => step.kind === 'think_aloud').map((step) => step.case_number),
  ).toEqual([5, 6, 7])
  expect(initial.steps.some((step) => step.kind === 'phase_transition')).toBe(false)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const visited: string[] = []
  for (const [index, step] of initial.steps.entries()) {
    await expect.poll(async () => (await getSession()).current_step_index).toBe(index)
    visited.push(pageKey(step))
    const next = page.getByRole('button', { name: 'Weiter', exact: true })
    switch (step.kind) {
      case 'welcome':
        await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
        await expect(page.getByText('Neun Fälle', { exact: false })).toHaveCount(0)
        await next.click()
        break
      case 'questionnaire':
        await expect(page.getByRole('heading', { name: step.title, exact: true })).toBeVisible()
        await expect(page.locator('[data-aoi="page_description"]')).toHaveText(
          `Fragebogenseite ${step.page} von ${step.page_count} insgesamt`,
        )
        await expect(page.locator(`[data-aoi="question.${step.questions[0].id}"]`)).toBeVisible()
        if (step.section_key === 'pck') await expectPageFits(page)
        if (step.questions[0]?.id === 'ck_pre_02') {
          await page.getByRole('spinbutton').fill('6')
          await page
            .getByRole('button', {
              name: 'Ich finde den Fehler nicht, Aufgabe überspringen',
              exact: true,
            })
            .click()
        } else {
          await fillQuestions(page, step.questions)
          if (step.section_key === 'pck' || step.section_key === 'mesp') {
            await page.screenshot({
              path: info.outputPath(`page-${index}-${step.section_key}.png`),
              fullPage: true,
            })
          }
          await expect(next).toBeEnabled()
          if (step.section_key === 'pck') await expectPageFits(page)
          await next.click()
        }
        break
      case 'section_intro':
        await expect(page.getByRole('heading', { name: step.title, exact: true })).toBeVisible()
        if (step.section_key === 'mesp')
          await expect(
            page.getByText(
              'Sie können dieselbe Bewertung innerhalb einer Aufgabe mehrmals vergeben.',
              { exact: false },
            ),
          ).toBeVisible()
        await next.click()
        break
      case 'text_page':
        await expect(next).toBeVisible()
        if (step.key === 'post_intro') {
          await expect(page.locator('.panel').getByRole('heading')).toHaveCount(0)
          await expect(
            page.getByText('Sie haben die Diagnoseaufgaben abgeschlossen.', { exact: false }),
          ).toBeVisible()
        }
        await page.screenshot({
          path: info.outputPath(`page-${index}-${step.key}.png`),
          fullPage: true,
        })
        await next.click()
        break
      case 'sosci':
        if (step.variant === 'posttest')
          await expect(
            page.getByText('Ihre Teilnehmer-ID wird automatisch übergeben.', { exact: false }),
          ).toHaveCount(0)
        await completeSosci(page)
        break
      case 'case_intro':
        await expect(
          page.getByRole('heading', { name: `Fall ${step.case_number}`, exact: true }),
        ).toBeVisible()
        // An Internet connectivity hint must not pause requests to a reachable lab API.
        if (step.case_number === 2)
          await page.evaluate(() => window.dispatchEvent(new Event('offline')))
        await next.click()
        await page.getByRole('button', { name: 'Ohne Blickdaten fortfahren', exact: true }).click()
        if (step.case_number === 2) {
          try {
            await expect.poll(async () => (await getSession()).current_step_index).toBe(index + 1)
            await expect(page.getByLabel('Notizen', { exact: true })).toBeVisible()
          } finally {
            await page.evaluate(() => window.dispatchEvent(new Event('online')))
          }
        }
        break
      case 'case_video': {
        await expect(
          page.getByText(`Video-Phase · Fall ${step.case_number} von 7`, { exact: true }),
        ).toBeVisible()
        await page
          .getByRole('button', { name: 'Schüler-Aufgabe und gegebener Code', exact: true })
          .click()
        await expect(
          page.locator('.modal code').filter({ hasText: 'Heizung' }).first(),
        ).toBeVisible()
        await expect(page.locator('.modal .code__line[data-line="1"]')).toHaveCount(2)
        await page.getByRole('button', { name: 'Schließen', exact: true }).click()
        await page.getByLabel('Notizen', { exact: true }).fill(`Notiz zu Fall ${step.case_number}`)
        if (step.case_number === 1)
          await page.screenshot({ path: info.outputPath('video-rail.png'), fullPage: true })
        await next.click()
        await page
          .getByRole('dialog', { name: 'Fall abschließen?' })
          .getByRole('button', { name: 'Zur Diagnose' })
          .click()
        break
      }
      case 'diagnosis':
        await page
          .getByLabel('Was war das Problem? Schreiben Sie Ihre Diagnose.', { exact: true })
          .fill('Der Grenzwert wird nicht richtig berücksichtigt.')
        await fillQuestions(page, step.questions)
        await next.click()
        break
      case 'case_outro':
        await expect(
          page.getByText('Ich empfand die Situation als authentisch', { exact: false }),
        ).toBeVisible()
        await fillQuestions(page, step.questions)
        await next.click()
        break
      case 'think_aloud':
        await expect(page.getByText(/Vortest|Nachtest|Trainingsfall/)).toHaveCount(0)
        await expect(
          page.getByText(`Erörterungs-Phase · Fall ${step.case_number} von 7`, { exact: true }),
        ).toBeVisible()
        await next.click()
        break
      case 'thanks':
        await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
        break
      default:
        throw new Error(`Unexpected pilot step ${step.kind}`)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
  }
  expect(visited).toEqual(initial.steps.map(pageKey))
  const exported = await request.get(`${API}/admin/studies/${studyId}/export/responses`, {
    headers: headers(token),
    params: { participant_ids: participantId },
  })
  expect(exported.ok()).toBeTruthy()
  const csv = await exported.text()
  expect(csv).toContain('mesp_pre_6e')
  expect(csv).not.toContain('msk_pre_')
  const rows = csvRecords(csv)
  const skipped = rows.find((row) => 'ck_pre_02' in JSON.parse(row.answers))!
  expect(skipped.response_status).toBe('skipped')
  expect(JSON.parse(skipped.answers)).toEqual({
    ck_pre_02: { lines: [0], explanation: '', skipped: true },
  })
  const mesp = rows.filter((row) => row.section_key === 'mesp')
  expect(mesp).toHaveLength(6)
  expect(mesp.flatMap((row) => Object.values(JSON.parse(row.answers)))).toEqual(Array(30).fill(1))
  expect(csv).toContain('pck_pre_3b_justification')
  expect(errors).toEqual([])
  await info.attach('visited-pages', {
    body: JSON.stringify(visited, null, 2),
    contentType: 'application/json',
  })
})

async function expectPageFits(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  expect(
    await page.evaluate(() => ({
      width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      scrollY,
    })),
  ).toEqual({ width: 1920, height: 1080, viewportWidth: 1920, viewportHeight: 1080, scrollY: 0 })
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeInViewport({
    ratio: 1,
  })
}

test('expired CK resumes after reload, saves the partial answer and automatically enters PCK', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const { token, studyId, participantId } = await seed(request)
  const pages = await api<{ id: number; placement: string; section_key: string }[]>(
    request,
    `/admin/studies/${studyId}/questionnaires`,
    token,
  )
  for (const item of pages.filter(
    (item) => item.placement === 'pre_test' && !['ck_tasks', 'pck'].includes(item.section_key),
  )) {
    await api(request, `/admin/questionnaires/${item.id}?force=true`, token, 'DELETE')
  }
  const participantToken = await login(page, participantId)
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Debugging-Aufgaben', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('spinbutton').fill('3')
  await page
    .getByLabel('Was ist der Fehler?', { exact: true })
    .fill('Noch unvollständige Überlegung')
  // This database is created solely for this browser suite; production has no clock override.
  const backend = fileURLToPath(new URL('../../backend/', import.meta.url))
  execFileSync(
    `${backend}.venv/bin/python`,
    [
      '-c',
      `
import asyncio, os, sys
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
url = os.environ['DATABASE_URL']
assert 'e2e' in url.rsplit('/', 1)[-1], 'Only an isolated e2e database may change its deadline'
async def main():
    engine = create_async_engine(url)
    async with engine.begin() as connection:
        await connection.execute(text('UPDATE section_attempts SET deadline_ms = 1 WHERE participant_id = :participant'), {'participant': sys.argv[1]})
    await engine.dispose()
asyncio.run(main())
`,
      participantId,
    ],
    { cwd: backend, env: process.env },
  )
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Fachdidaktisches Wissen', exact: true }),
  ).toBeVisible({ timeout: 15_000 })
  const session = await api<SessionScript>(request, '/participant/session', participantToken)
  expect(session.section_timing?.finished).toBe(true)
  const current = session.steps[session.current_step_index]
  expect(current).toMatchObject({ kind: 'section_intro', section_key: 'pck' })
  const exported = await request.get(`${API}/admin/studies/${studyId}/export/responses`, {
    headers: headers(token),
    params: { participant_ids: participantId },
  })
  const csv = await exported.text()
  const rows = csvRecords(csv)
  expect(rows).toHaveLength(1)
  expect(rows[0].response_status).toBe('partial')
  expect(JSON.parse(rows[0].answers)).toEqual({
    ck_pre_01: { lines: [3], explanation: 'Noch unvollständige Überlegung' },
  })
})
