import { expect, test, type Page } from '@playwright/test'

import type { AdminQuestionnaire, Study, StudyTexts } from '../src/api/admin'
import type { Question } from '../src/lib/questionnaire'

const API = 'http://a04.invalid'
const question: Question = {
  id: 'ck_browser_example',
  type: 'debugging',
  text: 'In welcher Zeile befindet sich der Fehler?',
  min: 1,
  max: 4,
  max_entries: 5,
  code_blocks: [
    {
      filename: 'Beispiel.java',
      start_line: 1,
      code: ['', 'int x = 1;', 'x = x + 1', 'System.out.println(x);'],
    },
  ],
}

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
  const state = {
    study: {
      id: 8,
      name: 'Pretest-Editor-Prüfung',
      description: '',
      sosci_pretest_url: '',
      sosci_posttest_url: '',
      sosci_id_param: 'id',
      is_active: true,
      think_aloud_batch_size: 1,
      video_defaults: { time_limit_seconds: 420, task_description: '', info_text: '' },
      texts: {
        welcome_title: 'Willkommen',
        welcome_intro: '',
        welcome_steps: ['Fragen', 'Videos'],
        welcome_note: '',
        case_intro_title: 'Bestehende allgemeine Einleitung',
        case_intro_body: 'Text für alle Fälle.',
        pre_test_case_intro_title: '',
        pre_test_case_intro_body: '',
        case_outro_title: '',
        case_outro_body: '',
        think_aloud_title: '',
        think_aloud_body: '',
      },
    } satisfies Study,
    pages: [
      {
        id: 101,
        study_id: 8,
        placement: 'pre_test',
        title: 'CK vor Änderung',
        description: 'Beschreibung bleibt erhalten.',
        section: 'CK-Aufgaben',
        section_key: 'ck_tasks',
        intro_title: 'CK-Einleitung',
        intro_body: 'Sie haben sieben Minuten.',
        order_index: 4,
        questions: [structuredClone(question)],
      },
    ] as AdminQuestionnaire[],
    updates: [] as Partial<AdminQuestionnaire>[],
    creates: [] as Partial<AdminQuestionnaire>[],
    texts: [] as StudyTexts[],
    failNext: false,
    unexpected: [] as string[],
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
    if (path === '/admin/studies/8') {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as { texts: StudyTexts }
        state.texts.push(body.texts)
        state.study = { ...state.study, texts: body.texts } as typeof state.study
      }
      return json(state.study)
    }
    if (path === '/admin/studies/8/videos') return json([])
    if (path === '/admin/studies/8/questionnaires') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as AdminQuestionnaire
        state.creates.push(body)
        const added = { ...body, id: 102, study_id: 8 }
        state.pages.push(added)
        return json(added)
      }
      return json(state.pages)
    }
    if (path === '/admin/questionnaires/101' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Partial<AdminQuestionnaire>
      state.updates.push(body)
      if (state.failNext) {
        state.failNext = false
        return route.fulfill({ headers, status: 503, json: { detail: 'Temporary failure' } })
      }
      state.pages[0] = { ...state.pages[0], ...body }
      return json(state.pages[0])
    }
    state.unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ headers, status: 404, json: { detail: path } })
  })
  return state
}

test('existing questionnaire edits preserve content and retry keeps draft', async ({
  page,
}, info) => {
  const state = await setup(page)
  await page.goto('/admin/studies/8?tab=questionnaires')
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click()
  await expect(page.getByLabel('Titel', { exact: true })).toHaveValue('CK vor Änderung')
  await expect(page.getByLabel('Abschnittsfunktion')).toHaveValue('ck_tasks')
  await expect(page.getByLabel('Reihenfolge', { exact: true })).toHaveValue('4')
  await page.getByLabel('Titel', { exact: true }).fill('CK nach Änderung')
  await page.getByLabel('Überschrift der Abschnittseinleitung').fill('Einleitung bearbeitet')
  await page
    .getByLabel('Text der Abschnittseinleitung')
    .fill('Bitte lesen Sie den Code. **7 Minuten Zeit**.')
  const originalJson = await page.getByLabel('Fragen (JSON-Array)').inputValue()
  const preview = page.locator('.preview')
  for (let i = 1; i < 5; i++)
    await preview.getByRole('button', { name: /Fehler bezieht sich/ }).click()
  await expect(preview.getByRole('spinbutton')).toHaveCount(5)
  await expect(preview.getByRole('button', { name: /Fehler bezieht sich/ })).toBeDisabled()
  await expect(preview.locator('.code__line').first()).toHaveAttribute('data-line', '1')
  expect(await preview.locator('.code__line').first().textContent()).toMatch(/^\s*$/)
  await preview.screenshot({ path: info.outputPath('admin-ck-preview-five-lines.png') })

  state.failNext = true
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect(
    page.getByText('Der Fragebogen konnte nicht gespeichert werden. Bitte prüfen Sie die Angaben.'),
  ).toBeVisible()
  await expect(page.getByLabel('Titel', { exact: true })).toHaveValue('CK nach Änderung')
  await expect(page.getByLabel('Fragen (JSON-Array)')).toHaveValue(originalJson)
  await expect(page.getByLabel('Text der Abschnittseinleitung')).toHaveValue(
    'Bitte lesen Sie den Code. **7 Minuten Zeit**.',
  )
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect.poll(() => state.updates.length).toBe(2)
  expect(state.updates[1]).toMatchObject({
    title: 'CK nach Änderung',
    section_key: 'ck_tasks',
    order_index: 4,
    intro_title: 'Einleitung bearbeitet',
    intro_body: 'Bitte lesen Sie den Code. **7 Minuten Zeit**.',
    description: 'Beschreibung bleibt erhalten.',
    questions: [question],
  })
  await page.reload()
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click()
  await expect(page.getByLabel('Titel', { exact: true })).toHaveValue('CK nach Änderung')
  await expect(page.getByLabel('Text der Abschnittseinleitung')).toHaveValue(
    'Bitte lesen Sie den Code. **7 Minuten Zeit**.',
  )
  await page.getByLabel('Abschnittsfunktion').scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('admin-section-intro-editor.png') })
  expect(state.unexpected).toEqual([])
})

test('CK and PCK presets preview their controls and save a new ranking page', async ({
  page,
}, info) => {
  const state = await setup(page)
  await page.goto('/admin/studies/8?tab=questionnaires')
  await page.getByRole('button', { name: 'CK-Debugging (max. 5 Zeilen)', exact: true }).click()
  let definitions = JSON.parse(await page.getByLabel('Fragen (JSON-Array)').inputValue())
  expect(definitions[0]).toMatchObject({ type: 'debugging', max_entries: 5 })
  const preview = page.locator('.preview')
  await expect(preview.getByRole('spinbutton')).toHaveCount(1)
  await page.getByRole('button', { name: 'Mehrfachauswahl', exact: true }).click()
  definitions = JSON.parse(await page.getByLabel('Fragen (JSON-Array)').inputValue())
  expect(definitions[0]).toMatchObject({ type: 'multi_select' })
  const checkboxes = preview.getByRole('checkbox')
  await expect(checkboxes).toHaveCount(definitions[0].options.length)
  await expect(preview.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()
  await checkboxes.nth(0).check()
  await checkboxes.nth(1).check()
  await expect(checkboxes.nth(0)).toBeChecked()
  await expect(checkboxes.nth(1)).toBeChecked()
  await expect(preview.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await preview.screenshot({ path: info.outputPath('admin-pck-multi-select-preview.png') })
  await checkboxes.nth(0).uncheck()
  await expect(checkboxes.nth(1)).toBeChecked()
  await checkboxes.nth(1).uncheck()
  await expect(preview.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()

  // The existing single-choice preset must retain radio exclusivity.
  await page.getByRole('button', { name: 'Auswahl & Freitext', exact: true }).click()
  const radios = preview.getByRole('radio')
  await expect(radios).toHaveCount(2)
  await expect(preview.getByRole('checkbox')).toHaveCount(0)
  await radios.nth(0).check()
  await expect(radios.nth(0)).toBeChecked()
  await radios.nth(1).check()
  await expect(radios.nth(0)).not.toBeChecked()
  await expect(radios.nth(1)).toBeChecked()

  await page.getByRole('button', { name: 'Reihenfolge (PCK)', exact: true }).click()
  await page.getByLabel('Titel', { exact: true }).fill('PCK-Beispiel')
  await page.getByLabel('Abschnittsfunktion').selectOption('pck')
  await page.getByLabel('Überschrift der Abschnittseinleitung').fill('PCK-Einleitung')
  await page.getByLabel('Text der Abschnittseinleitung').fill('Ordnen Sie die Schritte.')
  await expect(preview.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()
  const labels = preview.locator('.ranking__label')
  const first = await labels.nth(0).textContent()
  const second = await labels.nth(1).textContent()
  await preview
    .getByRole('button', { name: /Nach unten/ })
    .first()
    .click()
  await expect(labels.nth(0)).toHaveText(second!)
  await expect(labels.nth(1)).toHaveText(first!)
  await expect(preview.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await preview.screenshot({ path: info.outputPath('admin-pck-ranking-preview.png') })
  definitions = JSON.parse(await page.getByLabel('Fragen (JSON-Array)').inputValue())
  await page.getByRole('button', { name: 'Anlegen', exact: true }).click()
  await expect.poll(() => state.creates.length).toBe(1)
  expect(state.creates[0]).toMatchObject({
    title: 'PCK-Beispiel',
    section_key: 'pck',
    intro_title: 'PCK-Einleitung',
    intro_body: 'Ordnen Sie die Schritte.',
    questions: definitions,
  })
  expect(state.unexpected).toEqual([])
})

test('pretest-video wording saves independently of the generic case introduction', async ({
  page,
}, info) => {
  const state = await setup(page)
  await page.goto('/admin/studies/8?tab=details')
  await page.getByLabel('Überschrift für das Vortest-Video').fill('Vor Ihrem ersten Video')
  await page
    .getByLabel('Einleitung für das Vortest-Video')
    .fill('Bitte beobachten Sie den ersten Fall aufmerksam.')
  const textCard = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: 'Texte für Teilnehmer', exact: true }) })
  await textCard.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect.poll(() => state.texts.length).toBe(1)
  expect(state.texts[0]).toMatchObject({
    pre_test_case_intro_title: 'Vor Ihrem ersten Video',
    pre_test_case_intro_body: 'Bitte beobachten Sie den ersten Fall aufmerksam.',
    case_intro_title: 'Bestehende allgemeine Einleitung',
    case_intro_body: 'Text für alle Fälle.',
    welcome_steps: ['Fragen', 'Videos'],
  })
  await page.reload()
  await expect(page.getByLabel('Überschrift für das Vortest-Video')).toHaveValue(
    'Vor Ihrem ersten Video',
  )
  await expect(page.getByLabel('Einleitung für das Vortest-Video')).toHaveValue(
    'Bitte beobachten Sie den ersten Fall aufmerksam.',
  )
  await page.getByLabel('Überschrift für das Vortest-Video').scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('admin-pretest-video-intro.png') })
  expect(state.unexpected).toEqual([])
})
