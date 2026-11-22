import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

import type { AdminQuestionnaire } from '../src/api/admin'
import type { Question } from '../src/lib/questionnaire'

type SourcePage = { title: string; description: string; questions: Question[] }

const API = 'http://a04.invalid'
const instrument = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../backend/app/data/${file}`, import.meta.url), 'utf8')) as {
    pck_pages: SourcePage[]
  }
const revised = instrument('pretest_pilot20261120.json')
const firstPilot = instrument('pretest_pilot20261116.json')

function page(id: number, source: SourcePage): AdminQuestionnaire {
  return {
    id,
    study_id: 8,
    placement: 'pre_test',
    title: source.title,
    description: source.description,
    section: 'PCK-Pretest',
    section_key: 'pck',
    intro_title: '',
    intro_body: '',
    order_index: id,
    questions: structuredClone(source.questions),
  } as AdminQuestionnaire
}

async function openEditor(
  browser: Page,
  flow: 'pilot_20261116' | 'legacy',
  pages: AdminQuestionnaire[],
) {
  await browser.setViewportSize({ width: 1920, height: 1080 })
  await browser.addInitScript(() => {
    const payload = { sub: 'TEST-ADMIN', role: 'admin', exp: 4_000_000_000 }
    localStorage.setItem(
      'a04_auth',
      JSON.stringify({ token: `e30.${btoa(JSON.stringify(payload))}.test` }),
    )
    localStorage.setItem('i18nextLng', 'de')
  })
  await browser.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers, status: 204 })
    if (path === '/admin/studies/8')
      return route.fulfill({
        headers,
        json: {
          id: 8,
          name: 'Vorschau',
          description: '',
          sosci_pretest_url: '',
          sosci_posttest_url: '',
          sosci_id_param: 'id',
          is_active: true,
          think_aloud_batch_size: 1,
          flow_version: flow,
          think_aloud_mode: 'bundled',
          think_aloud_count: 3,
          video_defaults: { time_limit_seconds: 900, task_description: '', info_text: '' },
          texts: {},
        },
      })
    if (path === '/admin/studies/8/questionnaires') return route.fulfill({ headers, json: pages })
    return route.fulfill({ headers, json: [] })
  })
  await browser.goto('/admin/studies/8?tab=questionnaires')
}

async function edit(browser: Page, id: number) {
  const row = browser
    .getByRole('table', { name: 'Alle Fragebogenseiten', exact: true })
    .getByRole('row')
    .filter({ has: browser.getByRole('cell', { name: String(id), exact: true }) })
  await row.getByRole('button', { name: 'Bearbeiten', exact: true }).click()
  const preview = browser.getByLabel('Vorschau', { exact: true })
  await expect(
    preview.getByRole('heading', { level: 1 }).or(preview.locator('h2')).first(),
  ).toBeVisible()
  return preview
}

const box = async (locator: Locator) => (await locator.boundingBox())!

test('the preview of a revised PCK rating page is laid out as the participant sees it', async ({
  page: browser,
}, info) => {
  const pages = revised.pck_pages.map((source, index) => page(201 + index, source))
  await openEditor(browser, 'pilot_20261116', pages)
  // Task 1b: three statements rated on six points.
  const preview = await edit(browser, 202)
  await preview.scrollIntoViewIfNeeded()

  await expect(preview.locator('.pretest-page--pck-item')).toHaveCount(1)
  // The code beside the situation, not under it.
  const situation = await box(preview.locator('.study-stimulus__prose').first())
  const code = await box(preview.locator('.code').first())
  expect(code.x).toBeGreaterThan(situation.x + situation.width - 1)
  expect(Math.abs(code.y - situation.y)).toBeLessThan(80)
  // A label above each of the six columns, and no separate legend to look up.
  await expect(preview.locator('.matrix__scale-label')).toHaveText([
    'Sehr plausibel',
    'Plausibel',
    'Eher plausibel',
    'Eher nicht plausibel',
    'Nicht plausibel',
    'Gar nicht plausibel',
  ])
  await expect(preview.locator('.matrix__table tbody tr')).toHaveCount(3)
  await expect(preview.locator('.matrix--stacked')).toHaveCount(0)
  await expect(preview.locator('.matrix__legend')).toHaveCount(0)
  // The question spans the panel under the stimulus.
  const question = await box(preview.locator('.qlist').first())
  const panel = await box(preview.locator('.panel').first())
  expect(question.y).toBeGreaterThan(situation.y + situation.height - 1)
  expect(question.width).toBeGreaterThan(panel.width * 0.9)
  expect(
    await browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
  await preview.screenshot({ path: info.outputPath('preview-pck-1b.png') })
})

test('the preview keeps the three columns of a first-pilot PCK page', async ({ page: browser }) => {
  await openEditor(browser, 'pilot_20261116', [page(301, firstPilot.pck_pages[0])])
  const preview = await edit(browser, 301)
  await expect(preview.locator('.pretest-page--pck')).toHaveCount(1)
  await expect(preview.locator('.pretest-page--pck-item')).toHaveCount(0)
  await expect(preview.locator('.question-column')).not.toHaveCount(0)
})

test('a study on the earlier flow previews the same page without the pilot layout', async ({
  page: browser,
}) => {
  await openEditor(browser, 'legacy', [page(401, revised.pck_pages[1])])
  const preview = await edit(browser, 401)
  await expect(preview.locator('.pretest-page--pck-item')).toHaveCount(0)
  await expect(preview.locator('.pretest-page--pilot')).toHaveCount(0)
  await expect(preview.locator('.matrix__table tbody tr')).toHaveCount(3)
})
