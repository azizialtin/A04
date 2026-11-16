import { expect, test, type Page } from '@playwright/test'

import type { SessionStep } from '../src/api/participant'

const API = 'http://a04.invalid'

test('each SoSci survey must be opened before confirmation, including after reload', async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.addInitScript(() => {
    const token = `e30.${btoa(JSON.stringify({ sub: 'SOSCI-JOURNEY', role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
  })
  const steps: SessionStep[] = ['pretest', 'posttest'].map((variant, index) => ({
    index,
    completed: false,
    kind: 'sosci',
    variant: variant as 'pretest' | 'posttest',
    url: `https://survey.invalid/${variant}`,
    id_param: 'participant',
    participant_id: 'SOSCI-JOURNEY',
  }))
  steps.push({ kind: 'thanks', index: 2, completed: false })
  let current = 0
  const advances: number[] = []
  const unexpected: string[] = []
  const errors: string[] = []
  const surveyRequests: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await context.route('https://survey.invalid/**', (route) => {
    surveyRequests.push(route.request().url())
    return route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic SoSci survey</h1>' })
  })
  await page.route(API + '/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
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
      return route.fulfill({
        json: { id: 'SOSCI-JOURNEY', status: 'active', study_name: 'SoSci regression' },
      })
    if (path === '/participant/session')
      return route.fulfill({
        json: {
          flow_version: 'pilot_20261116',
          status: 'active',
          current_step_index: current,
          total_steps: steps.length,
          steps,
        },
      })
    if (path === '/participant/session/progress') {
      current = request.postDataJSON().current_step_index
      advances.push(current)
      return route.fulfill({
        json: { current_step_index: current, total_steps: steps.length, complete: current === 2 },
      })
    }
    if (path === '/participant/events') return route.fulfill({ json: { id: 1 } })
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { detail: path } })
  })

  const complete = page.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' })
  const link = page.getByRole('link', { name: 'Fragebogen öffnen', exact: true })
  const openSurvey = async (action: () => Promise<void>, variant: string, background = false) => {
    // A middle-click creates a background tab without an opener/popup event.
    const popupPromise = context.waitForEvent('page')
    await action()
    const popup: Page = await popupPromise
    const expectedUrl = `https://survey.invalid/${variant}?participant=SOSCI-JOURNEY`
    expect(popup).not.toBe(page)
    await expect.poll(() => surveyRequests).toContain(expectedUrl)
    // Keep a middle-clicked tab in the background. Native tab creation and the
    // routed navigation are the evidence of opening; neither submits a survey.
    if (!background) {
      await expect(popup.getByRole('heading', { name: 'Synthetic SoSci survey' })).toBeVisible()
      expect(popup.url()).toBe(expectedUrl)
      await popup.close()
      await page.bringToFront()
    }
    await expect(complete).toBeEnabled()
  }

  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Vorab-Fragebogen' })).toBeVisible()
  await expect(complete).toBeDisabled()
  await complete.evaluate((button: HTMLButtonElement) => button.click())
  expect(advances).toEqual([])
  await page.screenshot({ path: info.outputPath('before-opening.png'), fullPage: true })
  await link.focus()
  await openSurvey(() => link.press('Enter'), 'pretest')
  expect(advances).toEqual([]) // Opening is not completion.
  await page.reload()
  await expect(complete).toBeEnabled()
  await complete.click()

  await expect(page.getByRole('heading', { name: 'Abschluss-Fragebogen' })).toBeVisible()
  await expect(complete).toBeDisabled() // Opening pretest cannot unlock posttest.
  await expect(page.getByText(/Ihre Teilnehmer-ID wird/)).toHaveCount(0)
  await openSurvey(() => link.click({ button: 'middle' }), 'posttest', true)
  expect(advances).toEqual([1])
  await page.screenshot({ path: info.outputPath('ready-to-confirm.png'), fullPage: true })
  expect(
    await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    })),
  ).toEqual({ width: 1920, height: 1080 })
  await complete.click()
  await expect(page.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible()
  expect(advances).toEqual([1, 2])
  expect(unexpected).toEqual([])
  expect(errors).toEqual([])
})
