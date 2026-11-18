import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { SessionStep } from '../src/api/participant'
import type { GazeLayout } from '../src/lib/gazeGeometry'
import { normaliseOption, type Question } from '../src/lib/questionnaire'
import { expectNoHorizontalOverflow } from './layout'

type SourceTask = { source_task: number; title: string; description: string; questions: Question[] }

const API = 'http://a04.invalid'
const captureChecks: { gazeRequests: string[]; bridgeCommands: string[] }[] = []
test.beforeEach(() => {
  captureChecks.length = 0
})
test.afterEach(() => {
  for (const state of captureChecks) {
    expect(
      state.gazeRequests,
      'non-video screens must not create or upload gaze recordings',
    ).toEqual([])
    expect(state.bridgeCommands, 'non-video screens must not request gaze streaming').not.toContain(
      'start_gaze',
    )
  }
})

async function measureGeometry(page: Page): Promise<GazeLayout> {
  // Test-only DOM inspection; participants never start a gaze subscription here.
  return page.evaluate(async () => {
    const modulePath = '/src/lib/aoi.ts'
    const { capturePageGeometry } = await import(modulePath)
    return capturePageGeometry()
  })
}
const source = JSON.parse(
  readFileSync(
    new URL('../../backend/app/data/pretest_pilot20261116.json', import.meta.url),
    'utf8',
  ),
) as {
  pck_pages: SourceTask[]
  mesp_pages: SourceTask[]
  mesp_intro: { title: string; body: string }
}

async function openStep(
  page: Page,
  step: Extract<SessionStep, { kind: 'questionnaire' | 'section_intro' }>,
  viewport = { width: 1920, height: 1080 },
  flowVersion = 'pilot_20261116',
) {
  await page.setViewportSize(viewport)
  await page.addInitScript(() => {
    const token = `e30.${btoa(JSON.stringify({ sub: 'PILOT-LAYOUT', role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
    localStorage.setItem('i18nextLng', 'de')
  })
  const capture = { gazeRequests: [] as string[], bridgeCommands: [] as string[] }
  captureChecks.push(capture)
  await page.routeWebSocket('ws://127.0.0.1:8766', (ws) => {
    ws.send(
      JSON.stringify({ type: 'status', connected: true, frequency: 120, screen_recording: false }),
    )
    let samples: ReturnType<typeof setInterval> | undefined
    ws.onMessage((message) => {
      const request = JSON.parse(String(message))
      capture.bridgeCommands.push(request.type)
      if (request.type === 'start_gaze' && !samples) {
        samples = setInterval(
          () =>
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
            ),
          100,
        )
      }
      if (request.type === 'stop_gaze') {
        clearInterval(samples)
        samples = undefined
      }
    })
    ws.onClose(() => clearInterval(samples))
  })
  const state = {
    current: 0,
    answers: [] as Record<string, unknown>[],
    unexpected: [] as string[],
  }
  await page.route(API + '/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    const json = (value: unknown) => route.fulfill({ json: value })
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
      })
    if (path === '/participant/me')
      return json({ id: 'PILOT-LAYOUT', status: 'active', study_name: 'Pilot layout' })
    if (path === '/participant/session')
      return json({
        flow_version: flowVersion,
        status: 'active',
        current_step_index: state.current,
        total_steps: 2,
        section_timing: null,
        steps: [step, { kind: 'thanks', index: 1, completed: false }],
      })
    if (path === '/participant/session/questionnaire-visit')
      return json({ visit_id: request.postDataJSON().visit_id, section_timing: null })
    if (path.endsWith('/respond')) {
      state.answers.push(request.postDataJSON().answers)
      state.current = 1
      return json({ status: 'ok' })
    }
    if (path === '/participant/events') return json({ id: 1 })
    if (path.startsWith('/gaze/recordings')) {
      capture.gazeRequests.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 400, json: { detail: 'Gaze capture is video-only' } })
    }
    state.unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { detail: path } })
  })
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: step.title, exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  return state
}

async function openTask(
  page: Page,
  task: SourceTask,
  sectionKey: 'pck' | 'mesp' = 'pck',
  viewport = { width: 1920, height: 1080 },
) {
  const step: SessionStep = {
    ...task,
    index: 0,
    completed: false,
    kind: 'questionnaire',
    questionnaire_id: (sectionKey === 'mesp' ? 200 : 100) + task.source_task,
    placement: 'pre_test',
    section: sectionKey === 'mesp' ? 'MESP' : 'PCK-Pretest',
    section_key: sectionKey,
    video_id: null,
    page:
      sectionKey === 'mesp'
        ? 20 + source.mesp_pages.findIndex((page) => page.source_task === task.source_task)
        : 17 + source.pck_pages.findIndex((page) => page.source_task === task.source_task),
    page_count: 25,
  }
  const state = await openStep(page, step, viewport)
  await expect(page.locator('[data-aoi="page_description"]')).toHaveText(
    `Fragebogenseite ${step.page} von 25 insgesamt`,
  )
  return state
}

// Check before navigation: Playwright's click/fill helpers scroll offscreen elements
// into view, so a completed walkthrough alone cannot establish viewport fit.
async function assertFits(page: Page, info: TestInfo, label: string) {
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('.pretest-page .panel, .section-intro')!
    const elements = [
      ...panel.querySelectorAll<HTMLElement>(
        'h2, p, li, legend, th, td, pre, button, input, textarea, .matrix__scroll, .matrix__scale-label',
      ),
    ]
    const clipped = elements
      .filter((element) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)
          return false
        const style = getComputedStyle(element)
        return (
          (element.matches('.matrix__scale-label') &&
            element.scrollWidth > element.clientWidth + 1) ||
          (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1) ||
          (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX) &&
            element.scrollWidth > element.clientWidth + 1)
        )
      })
      .map((element) => element.className)
    const outside = elements
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.width &&
          box.height &&
          (box.top < -1 ||
            box.left < -1 ||
            box.bottom > innerHeight + 1 ||
            box.right > innerWidth + 1)
        )
      })
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent?.slice(0, 80),
      }))
    const prose = [
      ...panel.querySelectorAll<HTMLElement>(
        '.lead, .qfield__text, .matrix__prompt, .matrix__table tbody th, .matrix__scale-label, .choice__option, .ranking__label',
      ),
    ]
    const code = [...panel.querySelectorAll<HTMLElement>('pre.code')]
    const controls = [
      ...panel.querySelectorAll<HTMLElement>('button, textarea, .matrix__cell, .choice__option'),
    ]
    return {
      vertical:
        Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight,
      horizontal:
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      scrollY,
      clipped,
      outside,
      proseSize: Math.min(
        ...prose.map((element) => parseFloat(getComputedStyle(element).fontSize)),
      ),
      codeSize: code.length
        ? Math.min(...code.map((element) => parseFloat(getComputedStyle(element).fontSize)))
        : null,
      smallTargets: controls
        .filter((element) => {
          const box = element.getBoundingClientRect()
          return box.height < 24 || box.width < 24
        })
        .map((element) => element.className),
    }
  })
  await info.attach(label, {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  await page.mouse.move(1910, 1070)
  await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true })
  expect(metrics, label).toMatchObject({
    vertical: 0,
    horizontal: 0,
    scrollY: 0,
    clipped: [],
    outside: [],
    smallTargets: [],
  })
  expect(metrics.proseSize).toBeGreaterThanOrEqual(15)
  if (metrics.codeSize !== null) expect(metrics.codeSize).toBeGreaterThanOrEqual(14)
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeInViewport({
    ratio: 1,
  })
}

for (const task of source.pck_pages) {
  test(`pilot PCK source task ${task.source_task} fits without scrolling before and after answers`, async ({
    page,
  }, info) => {
    const state = await openTask(page, task)
    const next = page.getByRole('button', { name: 'Weiter', exact: true })
    await expect(next).toBeDisabled()
    await assertFits(page, info, 'unanswered')
    const ids = await page
      .locator('.questionnaire-controls [data-aoi]')
      .evaluateAll((elements) =>
        elements
          .map((element) => element.getAttribute('data-aoi')!)
          .filter((id) => /^question\.[^.]+$/.test(id)),
      )
    expect(ids).toEqual(task.questions.map((question) => `question.${question.id}`))
    const instruction = await page.locator('[data-aoi="instructions"]').boundingBox()
    const firstQuestion = await page.locator('.questionnaire-controls').boundingBox()
    expect(instruction!.y + instruction!.height).toBeLessThanOrEqual(firstQuestion!.y + 1)
    const expectedCode = task.description.match(/```java\n([\s\S]*?)\n```/)?.[1].split('\n') ?? []
    const lines = page.locator('.code__line')
    await expect(lines).toHaveCount(expectedCode.length)
    for (const [index, line] of expectedCode.entries()) {
      expect((await lines.nth(index).textContent())?.replace(/\n$/, '')).toBe(line)
      await expect(lines.nth(index)).toHaveAttribute('data-line', String(index + 1))
    }
    if (task.source_task === 3) expect(expectedCode).toHaveLength(17)

    const textQuestions = task.questions.filter((question) => question.type === 'free_text')
    for (const question of task.questions) {
      const field = page.locator(`[data-aoi="question.${question.id}"]`)
      if (question.type === 'multiple_choice' || question.type === 'likert')
        await field.getByRole('radio').first().check()
      else if (question.type === 'multi_select') {
        const choices = field.getByRole('checkbox')
        await choices.nth(0).check()
        await choices.nth(1).check()
        await expect(choices.nth(2)).toBeDisabled()
      } else if (question.type === 'ranking') {
        await field
          .getByRole('button', { name: /Nach oben verschieben/ })
          .nth(1)
          .click()
      }
    }
    await expect(next).toBeDisabled() // Free text/justification is still required.
    await assertFits(page, info, 'incomplete')
    for (const question of textQuestions) {
      await page
        .locator(`[data-aoi="question.${question.id}"]`)
        .getByRole('textbox')
        .fill('Die Aussage wird anhand der beschriebenen Situation begründet.')
    }
    await expect(next).toBeEnabled()
    await assertFits(page, info, 'answered')
    const last = await measureGeometry(page)
    for (const question of task.questions) {
      const bounds = await page.locator(`[data-aoi="question.${question.id}.prompt"]`).boundingBox()
      const area = last.aois?.find((item) => item.id === `question.${question.id}.prompt`)
      expect(area, `DOM area for ${question.id}`).toBeDefined()
      expect(area!.x).toBeCloseTo(bounds!.x, 0)
      expect(area!.y).toBeCloseTo(bounds!.y, 0)
    }
    await next.click()
    await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
    expect(state.answers).toHaveLength(1)
    expect(Object.keys(state.answers[0]).sort()).toEqual(
      task.questions.map((question) => question.id).sort(),
    )
    expect(state.unexpected).toEqual([])
  })
}

test('pilot MESP introduction fits with the full approved instructions', async ({ page }, info) => {
  const state = await openStep(page, {
    kind: 'section_intro',
    index: 0,
    completed: false,
    section_key: 'mesp',
    ...source.mesp_intro,
    time_limit_seconds: null,
  })
  const displayed = await page.locator('.section-intro p.lead, .section-intro li').allTextContents()
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  expect(normalize(displayed.join(' '))).toBe(
    normalize(source.mesp_intro.body.replace(/^- /gm, '')),
  )
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await assertFits(page, info, 'intro')
  expect(state.unexpected).toEqual([])
})

for (const task of source.mesp_pages) {
  test(`pilot MESP task ${task.source_task} fits with unchanged wording and response order`, async ({
    page,
  }, info) => {
    const state = await openTask(page, task, 'mesp')
    const next = page.getByRole('button', { name: 'Weiter', exact: true })
    await expect(next).toBeDisabled()
    await expect(page.locator('input:checked')).toHaveCount(0)
    await expect(page.getByRole('radio')).toHaveCount(30)
    const ids = await page
      .locator('.matrix__table tbody tr')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-aoi')))
    expect(ids).toEqual(task.questions.map((question) => `question.${question.id}`))
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
    expect(normalize(await page.locator('[data-aoi="instructions"]').innerText())).toBe(
      normalize(task.description),
    )
    const instruction = await page.locator('[data-aoi="instructions"]').boundingBox()
    const firstQuestion = await page.locator('.questionnaire-controls').boundingBox()
    expect(instruction!.y + instruction!.height).toBeLessThanOrEqual(firstQuestion!.y)
    for (const question of task.questions) {
      const field = page.locator(`[data-aoi="question.${question.id}"]`)
      const names = await field
        .getByRole('radio')
        .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label')))
      expect(names).toEqual(
        question.options!.map(
          (option, index) => `${question.text}: ${index + 1} – ${option.label}`,
        ),
      )
    }
    await expect(page.locator('.matrix__legend')).toHaveCount(0)
    expect(
      await page.locator('.matrix__table thead th:not(:first-child)').allTextContents(),
    ).toEqual(task.questions[0].options!.map((option, index) => `${index + 1}${option.label}`))
    await assertFits(page, info, 'unanswered')
    const expected: Record<string, unknown> = {}
    for (const [index, question] of task.questions.entries()) {
      const selectedIndex = (task.source_task + index - 1) % 6
      await page
        .locator(`[data-aoi="question.${question.id}"]`)
        .getByRole('radio')
        .nth(selectedIndex)
        .check()
      expected[question.id] = question.options![selectedIndex].value
    }
    await expect(next).toBeEnabled()
    await assertFits(page, info, 'answered')
    const last = await measureGeometry(page)
    const legendAreas = last.aois?.filter(
      (item) => item.id === `matrix.${task.questions[0].matrix}.legend`,
    )
    expect(legendAreas).toHaveLength(6)
    const headings = page.locator('.matrix__table thead th:not(:first-child)')
    for (const [index, area] of legendAreas!.entries()) {
      const bounds = await headings.nth(index).boundingBox()
      expect(area.x).toBeCloseTo(bounds!.x, 0)
      expect(area.y).toBeCloseTo(bounds!.y, 0)
      expect(area.w).toBeCloseTo(bounds!.width, 0)
    }
    for (const question of task.questions) {
      const bounds = await page.locator(`[data-aoi="question.${question.id}.prompt"]`).boundingBox()
      const area = last.aois?.find((item) => item.id === `question.${question.id}.prompt`)
      expect(area).toBeDefined()
      expect(area!.x).toBeCloseTo(bounds!.x, 0)
      expect(area!.y).toBeCloseTo(bounds!.y, 0)
    }
    await next.click()
    await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
    expect(state.answers).toEqual([expected])
    expect(state.unexpected).toEqual([])
  })
}

// Read the default MSK definitions from their authoritative Python source without
// importing the database-backed service. Only the pure MSK data/functions execute.
const defaultMsk: SourceTask[] = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      `
import ast, json, sys
source = ast.parse(open(sys.argv[1]).read())
names = {'MSK_SCALE', 'MSK_INSTRUCTION', 'MSK_QUESTION', 'MSK_TASKS', 'msk_questions', 'msk_description'}
def selected(node):
    if isinstance(node, ast.FunctionDef): return node.name in names
    if isinstance(node, ast.AnnAssign): return isinstance(node.target, ast.Name) and node.target.id in names
    if isinstance(node, ast.Assign): return any(isinstance(target, ast.Name) and target.id in names for target in node.targets)
    return False
namespace = {'Question': dict}
exec(compile(ast.Module(body=[node for node in source.body if selected(node)], type_ignores=[]), sys.argv[1], 'exec'), namespace)
print(json.dumps([{'source_task': index, 'title': 'MSK: Aufgabe ' + str(index), 'description': namespace['msk_description'](index, scenario), 'questions': namespace['msk_questions'](index, statements)} for index, (scenario, statements) in enumerate(namespace['MSK_TASKS'], 1)]))
`,
      fileURLToPath(new URL('../../backend/app/services/study_content.py', import.meta.url)),
    ],
    { encoding: 'utf8' },
  ),
)

async function answerSourceTask(page: Page, task: SourceTask) {
  const expected: Record<string, unknown> = {}
  for (const question of task.questions) {
    const field = page.locator(`[data-aoi="question.${question.id}"]`)
    if (question.type === 'multiple_choice' || question.type === 'likert') {
      const radios = field.getByRole('radio')
      if (question.options) await expect(radios).toHaveCount(question.options.length)
      // Checking the last option catches the previously offscreen rightmost cell.
      await radios.last().check()
      await expect(radios.last()).toBeChecked()
      expected[question.id] = question.options
        ? normaliseOption(question.options.at(-1)!).value
        : (question.scale_max ?? 5)
    } else if (question.type === 'multi_select') {
      const count = question.min_selections ?? 1
      for (let index = 0; index < count; index++)
        await field.getByRole('checkbox').nth(index).check()
      expected[question.id] = question
        .options!.slice(0, count)
        .map((option) => normaliseOption(option).value)
    } else if (question.type === 'free_text') {
      expected[question.id] = 'Begründung anhand der Unterrichtssituation.'
      await field.getByRole('textbox').fill(String(expected[question.id]))
    } else if (question.type === 'ranking') {
      await field
        .getByRole('button', { name: /Nach oben verschieben/ })
        .nth(1)
        .click()
      const values = question.options!.map((option) => normaliseOption(option).value)
      ;[values[0], values[1]] = [values[1], values[0]]
      expected[question.id] = values
    }
  }
  return expected
}

async function assertSourceChoicesFit(page: Page, task: SourceTask) {
  await expectNoHorizontalOverflow(page)
  for (const question of task.questions.filter((item) => item.matrix)) {
    const row = page.locator(`[data-aoi="question.${question.id}"]`)
    await expect(row.getByRole('radio')).toHaveCount(question.options!.length)
    expect(
      await row
        .getByRole('radio')
        .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
    ).toEqual(
      question.options!.map(
        (option, index) => `${question.text}: ${index + 1} – ${normaliseOption(option).label}`,
      ),
    )
  }
  const cropped = await page
    .locator('.matrix__cell, .matrix__option-label, .matrix__scale-label')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const box = element.getBoundingClientRect()
          return (
            box.width > 0 &&
            box.height > 0 &&
            (box.left < -1 ||
              box.right > innerWidth + 1 ||
              element.scrollWidth > element.clientWidth + 1)
          )
        })
        .map((element) => element.textContent),
    )
  expect(cropped).toEqual([])
}

for (const width of [1470, 1280, 1920, 768, 375]) {
  test(`real pilot and default MSK source choices fit at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000)
    const viewport = { width, height: 1080 }
    for (const [section, tasks] of [
      ['pck', source.pck_pages],
      ['mesp', source.mesp_pages],
      ['msk', defaultMsk],
    ] as const) {
      for (const task of tasks) {
        const state =
          section === 'msk'
            ? await openStep(
                page,
                {
                  ...task,
                  kind: 'questionnaire',
                  index: 0,
                  completed: false,
                  questionnaire_id: 300 + task.source_task,
                  placement: 'pre_test',
                  section: 'MSK',
                  section_key: 'msk',
                  video_id: null,
                  page: task.source_task,
                  page_count: defaultMsk.length,
                },
                viewport,
                'standard',
              )
            : await openTask(page, task, section, viewport)
        await assertSourceChoicesFit(page, task)
        const expected = await answerSourceTask(page, task)
        await assertSourceChoicesFit(page, task)
        if (section === 'mesp' && task.source_task === source.mesp_pages.at(-1)!.source_task) {
          await page.screenshot({
            path: info.outputPath(`real-${section}-${task.source_task}-${width}.png`),
            fullPage: true,
          })
        }
        await page.getByRole('button', { name: 'Weiter', exact: true }).click()
        await expect.poll(() => state.answers.length).toBe(1)
        expect(state.answers).toEqual([expected])
        expect(state.unexpected).toEqual([])
      }
    }
  })
}

test('real pilot MESP remains usable at 125 percent page zoom', async ({ page }, info) => {
  const task = source.mesp_pages.at(-1)!
  const state = await openTask(page, task, 'mesp', { width: 1470, height: 900 })
  await page.locator('html').evaluate((element) => {
    element.style.zoom = '1.25'
  })
  await assertSourceChoicesFit(page, task)
  const expected = await answerSourceTask(page, task)
  await assertSourceChoicesFit(page, task)
  await page.screenshot({ path: info.outputPath('real-mesp-125-percent-zoom.png'), fullPage: true })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect.poll(() => state.answers.length).toBe(1)
  expect(state.answers).toEqual([expected])
})
