import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Question } from '../src/lib/questionnaire'
import type { SectionTiming, SessionStep } from '../src/api/participant'
import type { GazeContext, GazeSample } from '../src/api/gaze'
import type { GazeLayout } from '../src/lib/gazeGeometry'

const API = 'http://a04.invalid'
const source = JSON.parse(
  readFileSync(new URL('../../backend/app/data/pretest_nov2026.json', import.meta.url), 'utf8'),
) as {
  ck_intro: { title: string; body: string }
  ck_tasks: { source_row: number; question: Question }[]
  pck_example: { title: string; description: string; questions: Question[] }
}

function script(): SessionStep[] {
  const steps: SessionStep[] = [
    {
      index: 0,
      completed: false,
      kind: 'section_intro',
      section_key: 'ck_tasks',
      ...source.ck_intro,
      time_limit_seconds: 420,
    },
  ]
  source.ck_tasks.forEach((task, index) => {
    steps.push({
      index: index + 1,
      completed: false,
      kind: 'questionnaire',
      section_key: 'ck_tasks',
      questionnaire_id: task.source_row,
      placement: 'pre_test',
      title: 'CK-Aufgabe ' + (index + 1),
      description: '',
      section: 'CK-Aufgaben',
      video_id: null,
      page: index + 1,
      page_count: 14,
      questions: [task.question],
    })
  })
  steps.push(
    {
      index: 14,
      completed: false,
      kind: 'section_intro',
      section_key: 'pck',
      title: 'PCK-Einleitung',
      body: 'Bitte bearbeiten Sie die folgende Unterrichtssituation.',
      time_limit_seconds: null,
    },
    {
      index: 15,
      completed: false,
      kind: 'questionnaire',
      section_key: 'pck',
      questionnaire_id: 99,
      placement: 'pre_test',
      section: 'PCK',
      video_id: null,
      page: 14,
      page_count: 14,
      ...source.pck_example,
    },
    {
      index: 16,
      completed: false,
      kind: 'case_intro',
      video_id: 7,
      phase_type: 'pre_test',
      title: 'Ihr Vortest-Video',
      body: 'Diese Einleitung gilt nur für das Vortest-Video.',
    },
    { index: 17, completed: false, kind: 'thanks' },
  )
  return steps
}

async function session(page: Page, initial = 0, expiresIn = 420_000, connectedGaze = false) {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.addInitScript(() => {
    const token =
      'e30.' +
      btoa(JSON.stringify({ sub: 'TEST-CK', role: 'participant', exp: 4_000_000_000 })) +
      '.test'
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
  })
  const bridgeCommands: string[] = []
  await page.routeWebSocket('ws://127.0.0.1:8766', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'status',
        connected: connectedGaze,
        frequency: 120,
        screen_recording: false,
      }),
    )
    ws.onMessage((message) => {
      const type = JSON.parse(String(message)).type
      bridgeCommands.push(type)
      if (type === 'start_gaze')
        ws.send(
          JSON.stringify({
            type: 'gaze',
            ts: Date.now(),
            lx: 0.5,
            ly: 0.5,
            rx: 0.5,
            ry: 0.5,
            lv: true,
            rv: true,
          }),
        )
    })
  })
  const state = {
    bridgeCommands,
    current: initial,
    steps: script(),
    timing: null as SectionTiming | null,
    visits: [] as { step_index: number; visit_id: string; client_ts: number }[],
    responses: [] as Record<string, unknown>[],
    finishes: [] as Record<string, unknown>[],
    failedFinishResponses: 0,
    failedResponseAcknowledgements: 0,
    responseRequests: [] as Record<string, unknown>[],
    recordings: [] as (GazeContext & {
      id: number
      layouts: GazeLayout[]
      completed: boolean
      samples: GazeSample[]
    })[],
    unexpected: [] as string[],
  }
  await page.route(API + '/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const json = (data: unknown) =>
      route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': '*' } })
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
      })
    if (path === '/participant/me')
      return json({ id: 'TEST-CK', status: 'active', study_name: 'Pretestprüfung' })
    if (path === '/participant/session')
      return json({
        status: 'active',
        current_step_index: state.current,
        total_steps: state.steps.length,
        steps: state.steps,
        section_timing: state.timing && { ...state.timing, server_now_ms: Date.now() },
      })
    if (path === '/participant/session/questionnaire-visit') {
      const body = req.postDataJSON()
      if (!state.visits.some((v) => v.visit_id === body.visit_id)) state.visits.push(body)
      if (!state.timing && body.step_index < 14)
        state.timing = {
          section_key: 'ck_tasks',
          deadline_ms: Date.now() + expiresIn,
          server_now_ms: Date.now(),
          finished: false,
          started_client_ts: body.client_ts,
          ended_client_ts: null,
        }
      return json({
        visit_id: body.visit_id,
        section_timing: state.timing && { ...state.timing, server_now_ms: Date.now() },
      })
    }
    if (path.endsWith('/respond')) {
      const body = req.postDataJSON()
      state.responseRequests.push(body)
      if (
        !body.visit_id ||
        !state.responses.some((response) => response.visit_id === body.visit_id)
      ) {
        state.responses.push(body)
        const step = state.steps[state.current]
        if (step.kind === 'questionnaire') step.previous_answers = body.answers
        if (body.advance) state.current += 1
      }
      if (state.failedResponseAcknowledgements > 0) {
        state.failedResponseAcknowledgements -= 1
        return route.abort('failed')
      }
      return json({ status: 'ok' })
    }
    if (path === '/participant/session/progress') {
      state.current = req.postDataJSON().current_step_index
      return json({
        current_step_index: state.current,
        total_steps: state.steps.length,
        complete: false,
      })
    }
    if (path === '/participant/session/finish-ck') {
      const body = req.postDataJSON()
      state.finishes.push(body)
      if (state.timing) {
        state.timing.finished = true
        state.timing.ended_client_ts = body.client_ts
      }
      state.current = 14
      if (state.failedFinishResponses > 0) {
        state.failedFinishResponses -= 1
        return route.abort('failed')
      }
      return json({ current_step_index: 14, total_steps: state.steps.length, complete: false })
    }
    if (path === '/participant/session/step-back') {
      state.current -= 1
      return json({
        current_step_index: state.current,
        total_steps: state.steps.length,
        complete: false,
      })
    }
    if (path === '/participant/events') return json({ id: 1 })
    if (path === '/gaze/recordings') {
      const body = req.postDataJSON()
      const id = state.recordings.length + 1
      state.recordings.push({
        id,
        video_id: body.video_id,
        step_kind: body.step_kind,
        step_index: body.step_index,
        layouts: [body.geometry],
        completed: false,
        samples: [],
      })
      return json({ recording_id: id })
    }
    const gaze = /^\/gaze\/recordings\/(\d+)\/(geometry|samples|complete)$/.exec(path)
    if (gaze) {
      const recording = state.recordings.find((item) => item.id === Number(gaze[1]))!
      if (gaze[2] === 'geometry') recording.layouts.push(req.postDataJSON())
      if (gaze[2] === 'samples') recording.samples.push(...req.postDataJSON().samples)
      if (gaze[2] === 'complete') recording.completed = true
      return json({ status: 'ok' })
    }
    state.unexpected.push(`${req.method()} ${path}`)
    return route.fulfill({ status: 404, json: { detail: path } })
  })
  await page.goto('/session')
  return state
}

async function fitsViewport(page: Page) {
  const overflow = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight - innerHeight,
    horizontal: document.documentElement.scrollWidth - innerWidth,
    code: [...document.querySelectorAll('pre.code')].some(
      (element) => element.scrollWidth > element.clientWidth + 1,
    ),
  }))
  expect(overflow).toEqual({ vertical: 0, horizontal: 0, code: false })
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeInViewport()
}

test('all thirteen source CK pages preserve code and fit with five line entries', async ({
  page,
}, info) => {
  expect(source.ck_tasks.map((task) => task.source_row)).toEqual(
    Array.from({ length: 13 }, (_, i) => i + 14),
  )
  expect(source.ck_tasks.map((task) => task.question.id)).toEqual([
    'ck_pre_01',
    'ck_pre_02',
    'ck_pre_03',
    'ck_pre_04',
    'ck_pre_05',
    'ck_pre_06',
    'ck_pre_07',
    'ck_pre_08',
    'ck_pre_09',
    'ck_pre_10',
    'ck_pre_11',
    'ck_pre_12',
    'ck_pre_13',
  ])
  expect(source.ck_tasks.find((task) => task.source_row === 25)?.question.id).toBe('ck_pre_12')
  expect(source.ck_tasks.find((task) => task.source_row === 26)?.question.id).toBe('ck_pre_13')
  const state = await session(page)
  await expect(page.getByText('7 Minuten Zeit', { exact: true })).toHaveJSProperty(
    'tagName',
    'STRONG',
  )
  expect(state.visits).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('ck-introduction.png') })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  for (let index = 0; index < source.ck_tasks.length; index++) {
    const task = source.ck_tasks[index]
    await expect(
      page.getByRole('heading', { name: 'CK-Aufgabe ' + (index + 1), exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('timer')).toBeVisible()
    const expectedLines = task.question.code_blocks!.flatMap((block) =>
      (block.code as string[]).map((line, offset) => ({
        line,
        number: (block.start_line ?? 1) + offset,
      })),
    )
    const lines = page.locator('.code__line')
    await expect(lines).toHaveCount(expectedLines.length)
    for (let lineIndex = 0; lineIndex < expectedLines.length; lineIndex++) {
      await expect(lines.nth(lineIndex)).toHaveAttribute(
        'data-line',
        String(expectedLines[lineIndex].number),
      )
      expect((await lines.nth(lineIndex).textContent())?.replace(/\n$/, '')).toBe(
        expectedLines[lineIndex].line,
      )
    }
    for (let added = 1; added < 5; added++)
      await page.getByRole('button', { name: /Fehler bezieht sich/ }).click()
    await expect(page.getByRole('spinbutton')).toHaveCount(5)
    await expect(page.getByRole('button', { name: /Fehler bezieht sich/ })).toBeDisabled()
    for (const input of await page.getByRole('spinbutton').all()) await input.fill('1')
    await page
      .getByLabel('Was ist der Fehler?', { exact: true })
      .fill('Beispielantwort für die Browserprüfung.')
    await fitsViewport(page)
    await page.screenshot({ path: info.outputPath('ck-source-row-' + task.source_row + '.png') })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'PCK-Einleitung' })).toBeVisible()
  expect(state.responses).toHaveLength(13)
  expect(
    state.responses.map((response) => Object.keys(response.answers as Record<string, unknown>)),
  ).toEqual(source.ck_tasks.map((task) => [task.question.id]))
  expect(state.visits.map((v) => v.step_index)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
})

test('timer expires without navigation; reload keeps draft and deadline; supervisor saves partial then skips', async ({
  page,
}, info) => {
  const state = await session(page, 2, 1500)
  await expect(page.getByRole('timer')).toBeVisible()
  await page.getByRole('spinbutton').fill('3')
  await page.getByLabel('Was ist der Fehler?', { exact: true }).fill('Noch nicht fertig')
  const deadline = state.timing!.deadline_ms
  await page.reload()
  await expect(page.getByRole('spinbutton')).toHaveValue('3')
  await expect(page.getByLabel('Was ist der Fehler?', { exact: true })).toHaveValue(
    'Noch nicht fertig',
  )
  expect(state.timing!.deadline_ms).toBe(deadline)
  await expect(page.getByRole('timer')).toHaveText('0:00', { timeout: 5000 })
  expect(state.current).toBe(2)
  await page.getByLabel('Was ist der Fehler?', { exact: true }).fill('')
  await page.keyboard.press('Control+Alt+Shift+N')
  await expect(page.getByRole('dialog', { name: 'CK-Abschnitt beenden' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('supervisor-finish.png') })
  await page.getByRole('button', { name: 'Speichern und zu PCK' }).click()
  await expect(page.getByRole('heading', { name: 'PCK-Einleitung' })).toBeVisible()
  expect(state.finishes).toHaveLength(1)
  expect(state.finishes[0].answers).toEqual({
    [source.ck_tasks[1].question.id]: { lines: [3], explanation: '' },
  })
  expect(state.visits.every((v) => v.step_index === 2)).toBe(true)
  expect(state.responses).toHaveLength(0)
  await page.keyboard.press('Control+Alt+Shift+N')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('PCK shared page supports explicit ranking and the pretest case uses its own introduction', async ({
  page,
}, info) => {
  await session(page, 15)
  await expect(page.getByRole('heading', { name: source.pck_example.title })).toBeVisible()
  for (const field of await page.locator('textarea').all())
    await field.fill('Antwort zur Unterrichtssituation.')
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Diese Reihenfolge übernehmen' }).click()
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await fitsViewport(page)
  await page.screenshot({ path: info.outputPath('pck-shared-page.png'), fullPage: true })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ihr Vortest-Video' })).toBeVisible()
  await expect(page.getByText('Diese Einleitung gilt nur für das Vortest-Video.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('pretest-case-introduction.png') })
})

test('a lost finish acknowledgement retries the same answer and timestamp without allowing a concurrent back', async ({
  page,
}) => {
  const state = await session(page, 1)
  state.failedFinishResponses = 3
  await page.getByRole('spinbutton').fill('2')
  await page.getByLabel('Was ist der Fehler?', { exact: true }).fill('Entwurf')
  await page.keyboard.press('Control+Alt+Shift+B')
  await page.keyboard.press('Control+Alt+Shift+N')
  await expect(
    page.getByRole('dialog', { name: 'Einen Schritt zurück (Studienleitung)' }),
  ).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click()
  await page.keyboard.press('Control+Alt+Shift+N')
  await page.keyboard.press('Control+Alt+Shift+B')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.getByRole('button', { name: 'Speichern und zu PCK' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('spinbutton')).toBeDisabled()
  expect(state.finishes).toHaveLength(3)
  await page.getByRole('button', { name: 'Speichern und zu PCK' }).click()
  await expect(page.getByRole('heading', { name: 'PCK-Einleitung' })).toBeVisible()
  expect(state.finishes).toHaveLength(4)
  for (const retry of state.finishes) expect(retry).toEqual(state.finishes[0])
  expect(state.current).toBe(14)
})

test('CK pages, answer edits and supervisor popups never collect gaze', async ({ page }, info) => {
  const sourceIndex = source.ck_tasks.findIndex((task) => task.question.code_blocks?.length === 2)
  expect(sourceIndex).toBeGreaterThanOrEqual(0)
  const state = await session(page, sourceIndex + 1, 420_000, true)
  await expect(page.getByRole('timer')).toBeVisible()
  await expect(page.locator('.question-code-file')).toHaveCount(2)
  await page.getByRole('spinbutton').fill('1')
  await expect(page.locator('.unsent')).toHaveCount(0)

  for (let count = 1; count < 5; count++)
    await page.getByRole('button', { name: /Fehler bezieht sich/ }).click()
  for (const input of await page.getByRole('spinbutton').all()) await input.fill('1')
  await expect(page.getByRole('spinbutton')).toHaveCount(5)
  await expect(page.getByRole('button', { name: /Fehler bezieht sich/ })).toBeDisabled()
  await fitsViewport(page)
  await page.screenshot({ path: info.outputPath('ck-two-files-five-lines.png') })
  expect(state.recordings).toHaveLength(0)
  expect(state.bridgeCommands).not.toContain('start_gaze')

  await page.getByRole('button', { name: 'Zeilennummer 5 entfernen', exact: true }).click()
  await expect(page.getByRole('spinbutton')).toHaveCount(4)
  await expect(page.getByRole('button', { name: /Fehler bezieht sich/ })).toBeEnabled()
  await page.getByRole('button', { name: 'Zeilennummer 4 entfernen', exact: true }).click()
  await expect(page.getByRole('spinbutton')).toHaveCount(3)

  await page.keyboard.press('Control+Alt+Shift+N')
  await expect(page.getByRole('dialog', { name: 'CK-Abschnitt beenden' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('ck-supervisor-modal.png') })
  expect(state.recordings).toHaveLength(0)
  expect(state.bridgeCommands).not.toContain('start_gaze')
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Re-enter the answer after closing, so the next supervisor action begins
  // after the form has resumed instead of racing its pending busy-state effect.
  await page.getByLabel('Was ist der Fehler?', { exact: true }).fill('Antwort nach dem Schließen.')
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await page.keyboard.press('Control+Alt+Shift+N')
  await expect(page.getByRole('dialog', { name: 'CK-Abschnitt beenden' })).toBeVisible()
  await page.getByRole('button', { name: 'Speichern und zu PCK', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'PCK-Einleitung' })).toBeVisible()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: source.pck_example.title })).toBeVisible()
  expect(state.recordings).toHaveLength(0)
  expect(state.bridgeCommands).not.toContain('start_gaze')
  expect(state.unexpected).toEqual([])
})

test('three lost response acknowledgements reconcile to the next CK page without duplicate answers or skipping', async ({
  page,
}) => {
  const state = await session(page, 1)
  state.failedResponseAcknowledgements = 3
  await page.getByRole('spinbutton').fill('2')
  await page
    .getByLabel('Was ist der Fehler?', { exact: true })
    .fill('Der Vergleich verwendet die falsche Grenze.')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'CK-Aufgabe 2', exact: true })).toBeVisible({
    timeout: 10_000,
  })
  expect(state.responseRequests).toHaveLength(3)
  for (const retry of state.responseRequests) expect(retry).toEqual(state.responseRequests[0])
  expect(state.responses).toHaveLength(1)
  expect(state.current).toBe(2)
  await expect(page.getByRole('spinbutton')).toHaveValue('')
  await expect(page.getByLabel('Was ist der Fehler?', { exact: true })).toHaveValue('')
  await expect.poll(() => state.visits.map((visit) => visit.step_index)).toEqual([1, 2])
  expect(state.unexpected).toEqual([])
})
