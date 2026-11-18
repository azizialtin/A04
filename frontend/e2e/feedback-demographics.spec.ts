import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { SessionStep } from '../src/api/participant'
import type { Question } from '../src/lib/questionnaire'
import { expectNoHorizontalOverflow } from './layout'

// Exercise the actual seeded questionnaire, including its conditional rules,
// without importing database services or duplicating instrument wording.
const questions: Question[] = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      `
import ast, json, sys
source = ast.parse(open(sys.argv[1]).read())
names = {'DEMOGRAPHICS', '_yes_no', '_years'}
def selected(node):
    if isinstance(node, ast.FunctionDef): return node.name in names
    if isinstance(node, ast.AnnAssign): return isinstance(node.target, ast.Name) and node.target.id in names
    return False
namespace = {'Question': dict}
exec(compile(ast.Module(body=[node for node in source.body if selected(node)], type_ignores=[]), sys.argv[1], 'exec'), namespace)
print(json.dumps(namespace['DEMOGRAPHICS']))
`,
      fileURLToPath(new URL('../../backend/app/services/study_content.py', import.meta.url)),
    ],
    { encoding: 'utf8' },
  ),
)

const API = 'http://a04.invalid'
const firstPage = 'Seite 1 von 2: Persönliche Angaben und Ausbildung'
const secondPage = 'Seite 2 von 2: Unterricht und Erfahrung'
const firstColumns = [
  ['sex', 'age', 'participant_group', 'st_degree'],
  ['st_enrollment', 'st_subject', 'st_semester', 'st_schulform', 'dupl1_st_schulform'],
]
const secondColumns = [
  ['st_fach1', 'st_fach2', 'st_fach3', 'st_schulpraktikum', 'st_unterricht', 'teach_class'],
  ['teach_inf_ex', 'teach_inf_year', 'teach_prog_ex', 'teach_prog_year', 'java_ex', 'java_years'],
]
const experiencePairs = [
  ['teach_inf_ex', 'teach_inf_year'],
  ['teach_prog_ex', 'teach_prog_year'],
  ['java_ex', 'java_years'],
] as const

function field(page: Page, id: string) {
  return page.locator(`[data-aoi="question.${id}"]`)
}

async function choose(page: Page, id: string, label: string) {
  await field(page, id).getByRole('radio', { name: label, exact: true }).check()
}

async function fill(page: Page, id: string, value: string) {
  await field(page, id).locator('input, textarea').fill(value)
}

async function openDemographics(page: Page, viewport = { width: 1920, height: 1080 }) {
  const step: SessionStep = {
    kind: 'questionnaire',
    index: 0,
    completed: false,
    questionnaire_id: 1,
    placement: 'pre_test',
    section: 'Demographics',
    section_key: 'demographics',
    title: 'Angaben zur Person',
    description: 'Bitte machen Sie einige Angaben zu sich und zu Ihrer Ausbildung.',
    questions,
    video_id: null,
    page: 1,
    page_count: 25,
  }
  const state = {
    current: 0,
    answers: [] as Record<string, unknown>[],
    unexpected: [] as string[],
    gazeCommands: [] as string[],
  }
  await page.setViewportSize(viewport)
  await page.addInitScript(() => {
    const token = `e30.${btoa(JSON.stringify({ sub: 'DEMOGRAPHICS-LAYOUT', role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
    localStorage.setItem('i18nextLng', 'de')
  })
  await page.routeWebSocket('ws://127.0.0.1:8766', (ws) => {
    ws.send(JSON.stringify({ type: 'status', connected: true, frequency: 120 }))
    ws.onMessage((message) => state.gazeCommands.push(JSON.parse(String(message)).type))
  })
  await page.route(API + '/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
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
      return json({ id: 'DEMOGRAPHICS-LAYOUT', status: 'active', study_name: 'Demographics' })
    if (path === '/participant/session')
      return json({
        flow_version: 'pilot_20261116',
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
    state.unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { detail: path } })
  })
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: step.title, exact: true })).toBeVisible()
  await expect(page.getByText(firstPage, { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  return state
}

async function expectColumnOrder(page: Page, expected: string[][]) {
  await expect(page.locator('.question-column')).toHaveCount(2)
  const ids = await page
    .locator('.question-column')
    .evaluateAll((columns) =>
      columns.map((column) =>
        [...column.querySelectorAll('.qfield')].map((element) =>
          element.getAttribute('data-aoi')!.replace('question.', ''),
        ),
      ),
    )
  expect(ids).toEqual(expected)
}

async function captureLayout(page: Page, info: TestInfo, label: string, stacked = false) {
  await expectNoHorizontalOverflow(page)
  const columns = page.locator('.question-column')
  const left = (await columns.nth(0).boundingBox())!
  const right = (await columns.nth(1).boundingBox())!
  if (stacked) {
    expect(right.y).toBeGreaterThanOrEqual(left.y + left.height)
    expect(Math.abs(left.x - right.x)).toBeLessThan(2)
  } else {
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width)
    expect(Math.abs(left.y - right.y)).toBeLessThan(2)
    await page.evaluate(() => window.scrollTo(0, 0))
    // Wide lab screens fit the full form; smaller windows may scroll vertically.
    if (page.viewportSize()!.width >= 1600)
      await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeInViewport({
        ratio: 1,
      })
  }
  await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true })
}

async function answerFirstPage(page: Page) {
  await choose(page, 'sex', 'weiblich')
  await fill(page, 'age', '26')
  await choose(page, 'participant_group', 'Lehramtsstudierende:r')
  await fill(page, 'st_degree', 'Bachelor')
  await choose(page, 'st_enrollment', 'ja')
  await fill(page, 'st_subject', 'Lehramt Informatik')
  await fill(page, 'st_semester', '5')
  await choose(page, 'st_schulform', 'andere')
  await fill(page, 'dupl1_st_schulform', 'Gesamtschule')
}

async function answerSecondPage(page: Page) {
  await fill(page, 'st_fach1', 'Informatik')
  await fill(page, 'st_fach2', 'Mathematik')
  await fill(page, 'st_fach3', 'Physik')
  await fill(page, 'st_schulpraktikum', '30')
  await fill(page, 'st_unterricht', '20')
  await fill(page, 'teach_class', '7–10')
  for (const [experience, years] of experiencePairs) {
    await choose(page, experience, 'ja')
    await fill(page, years, '2')
  }
}

test('demographics preserve conditional answers across both pages, back navigation, and reload', async ({
  page,
}, info) => {
  const state = await openDemographics(page)
  const next = page.getByRole('button', { name: 'Weiter', exact: true })
  const back = page.getByRole('button', { name: 'Zurück', exact: true })
  await expect(next).toBeDisabled()
  await expect(back).toHaveCount(0)
  await expectColumnOrder(page, [firstColumns[0], ['st_enrollment', 'st_schulform']])
  for (const id of ['st_subject', 'st_semester', 'dupl1_st_schulform'])
    await expect(field(page, id)).toHaveCount(0)
  await captureLayout(page, info, 'desktop-page-1-initial')

  await answerFirstPage(page)
  await expectColumnOrder(page, firstColumns)
  await fill(page, 'st_semester', '')
  await expect(next).toBeDisabled()
  await choose(page, 'st_enrollment', 'nein')
  await expect(field(page, 'st_subject')).toHaveCount(0)
  await expect(field(page, 'st_semester')).toHaveCount(0)
  await expect(next).toBeEnabled()
  await choose(page, 'st_enrollment', 'ja')
  await expect(next).toBeDisabled()
  await fill(page, 'st_semester', '5')
  await fill(page, 'dupl1_st_schulform', '')
  await expect(next).toBeDisabled()
  await choose(page, 'st_schulform', 'Gymnasium')
  await expect(field(page, 'dupl1_st_schulform')).toHaveCount(0)
  await expect(next).toBeEnabled()
  await choose(page, 'st_schulform', 'andere')
  await fill(page, 'dupl1_st_schulform', 'Gesamtschule')
  await captureLayout(page, info, 'desktop-page-1-expanded')
  await next.click()

  await expect(page.getByText(secondPage, { exact: true })).toBeVisible()
  expect(state.answers).toEqual([])
  await expectColumnOrder(page, [secondColumns[0], ['teach_inf_ex', 'teach_prog_ex', 'java_ex']])
  await expect(next).toBeDisabled()
  for (const [, years] of experiencePairs) await expect(field(page, years)).toHaveCount(0)
  await answerSecondPage(page)
  await expectColumnOrder(page, secondColumns)
  for (const [experience, years] of experiencePairs) {
    await fill(page, years, '')
    await expect(next).toBeDisabled()
    await choose(page, experience, 'nein')
    await expect(field(page, years)).toHaveCount(0)
    await expect(next).toBeEnabled()
    await choose(page, experience, 'ja')
    await expect(next).toBeDisabled()
    await fill(page, years, '2')
  }
  await captureLayout(page, info, 'desktop-page-2-expanded')

  await back.click()
  await expect(page.getByText(firstPage, { exact: true })).toBeVisible()
  await expect(field(page, 'age').getByRole('spinbutton')).toHaveValue('26')
  await choose(page, 'participant_group', 'Lehrkraft')
  await next.click()
  await expect(field(page, 'st_unterricht')).toHaveCount(0)
  await expect(next).toBeEnabled()
  await back.click()
  await choose(page, 'participant_group', 'Lehramtsstudierende:r')
  await next.click()
  await expect(field(page, 'st_unterricht').getByRole('spinbutton')).toHaveValue('20')
  expect(state.answers).toEqual([])

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Angaben zur Person', exact: true })).toBeVisible()
  // Both persisted-page and first-page restoration retain the same answer draft.
  if (await back.isVisible()) await back.click()
  await expect(field(page, 'st_subject').getByRole('textbox')).toHaveValue('Lehramt Informatik')
  await expect(field(page, 'age').getByRole('spinbutton')).toHaveValue('26')
  await next.click()
  await expect(field(page, 'st_fach1').getByRole('textbox')).toHaveValue('Informatik')
  await expect(field(page, 'java_years').getByRole('spinbutton')).toHaveValue('2')
  await expect(next).toBeEnabled()
  await next.click()
  await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
  expect(state.answers).toEqual([
    {
      sex: 1,
      age: 26,
      participant_group: 1,
      st_degree: 'Bachelor',
      st_enrollment: 1,
      st_subject: 'Lehramt Informatik',
      st_semester: 5,
      st_schulform: 7,
      dupl1_st_schulform: 'Gesamtschule',
      st_fach1: 'Informatik',
      st_fach2: 'Mathematik',
      st_fach3: 'Physik',
      st_schulpraktikum: 30,
      st_unterricht: 20,
      teach_class: '7–10',
      teach_inf_ex: 1,
      teach_inf_year: 2,
      teach_prog_ex: 1,
      teach_prog_year: 2,
      java_ex: 1,
      java_years: 2,
    },
  ])
  expect(state.unexpected).toEqual([])
  expect(state.gazeCommands).not.toContain('start_gaze')
})

for (const viewport of [
  { width: 1280, height: 900, label: 'laptop', stacked: false },
  { width: 390, height: 844, label: 'mobile', stacked: true },
]) {
  test(`demographics keep the authored reading order without horizontal scrolling on ${viewport.label}`, async ({
    page,
  }, info) => {
    const state = await openDemographics(page, viewport)
    await answerFirstPage(page)
    await expectColumnOrder(page, firstColumns)
    await captureLayout(page, info, `${viewport.label}-page-1-expanded`, viewport.stacked)
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByText(secondPage, { exact: true })).toBeVisible()
    await answerSecondPage(page)
    await expectColumnOrder(page, secondColumns)
    await captureLayout(page, info, `${viewport.label}-page-2-expanded`, viewport.stacked)
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
    expect(state.answers).toHaveLength(1)
    expect(Object.keys(state.answers[0]).sort()).toEqual(questions.map(({ id }) => id).sort())
    expect(state.unexpected).toEqual([])
    expect(state.gazeCommands).not.toContain('start_gaze')
  })
}
