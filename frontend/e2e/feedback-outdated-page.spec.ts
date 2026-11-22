import { expect, test, type Page, type Route } from '@playwright/test'

import type { SessionStep } from '../src/api/participant'

const API = 'http://a04.invalid'
const PARTICIPANT = 'QA-RELOAD'
const NOTICE =
  'Diese Seite ist nicht auf dem neuesten Stand. Bitte laden Sie sie neu, bevor Sie beginnen (Strg + F5), oder wenden Sie sich an das Studienteam.'
const RELOADED = 'Die Seite wurde auf den neuesten Stand gebracht. Bitte melden Sie sich jetzt an.'

// The shell of a release that went out after this tab was opened.
const RELEASED = `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <title>A04</title>
    <script type="module" crossorigin src="/assets/index-Released1.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-Released1.css">
  </head>
  <body><div id="root"></div></body>
</html>`

const steps: SessionStep[] = [
  { index: 0, completed: false, kind: 'welcome' },
  { index: 1, completed: false, kind: 'thanks' },
]

async function setup(page: Page) {
  const state = {
    // What the server's shell says now: this tab's own files, a newer release, or
    // nothing. `slow` keeps each request until the test answers it.
    server: 'same' as 'same' | 'released' | 'silent' | 'slow',
    slow: [] as Route[],
    // A reload that works brings the tab onto the released files.
    reloadCatchesUp: true,
    checks: 0,
    loads: 0,
    logins: [] as string[],
  }
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'de'))
  page.on('load', () => state.loads++)
  let documents = 0
  page.on('request', (request) => {
    // The router also navigates within the page; only a new document is a reload.
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return
    if (++documents > 1 && state.reloadCatchesUp) state.server = 'same'
  })
  await page.route('**/index.html', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue()
    state.checks++
    if (state.server === 'released')
      return route.fulfill({ contentType: 'text/html', body: RELEASED })
    // Left unanswered: the page gives up on its own.
    if (state.server === 'silent') return
    if (state.server === 'slow') return void state.slow.push(route)
    return route.continue()
  })
  await page.route(`${API}/**`, async (route) => {
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
    const json = (value: unknown) =>
      route.fulfill({ json: value, headers: { 'Access-Control-Allow-Origin': '*' } })
    if (path === '/auth/participant/login') {
      const id = request.postDataJSON().participant_id as string
      state.logins.push(id)
      const claims = btoa(JSON.stringify({ sub: id, role: 'participant', exp: 4_000_000_000 }))
      return json({ access_token: `e30.${claims}.test` })
    }
    if (path === '/participant/me') return json({ id: PARTICIPANT, status: 'active' })
    if (path === '/participant/session')
      return json({
        current_step_index: 0,
        total_steps: steps.length,
        status: 'active',
        complete: false,
        flow_version: 'pilot_20261116',
        steps,
        section_timing: null,
      })
    return json({ status: 'ok' })
  })
  return state
}

/** Someone clicks back into the window, long enough after the page last asked. */
async function returnToWindow(page: Page) {
  await page.clock.fastForward(11_000)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

const idField = (page: Page) => page.getByLabel('Teilnehmer-ID')
const signIn = (page: Page) => page.getByRole('button', { name: 'Anmelden', exact: true })

async function openLogin(page: Page, state: Awaited<ReturnType<typeof setup>>) {
  await page.goto('/login')
  await expect(idField(page)).toBeVisible()
  await expect.poll(() => state.checks).toBeGreaterThan(0)
}

test('an up-to-date login page asks the server and stays as it is', async ({ page }) => {
  const state = await setup(page)
  await openLogin(page, state)
  await idField(page).fill('TN-0')
  await page.waitForTimeout(700)
  expect(state.loads).toBe(1)
  await expect(idField(page)).toHaveValue('TN-0')
  await expect(page.getByText(NOTICE)).toHaveCount(0)
  await expect(page.getByText(RELOADED)).toHaveCount(0)
})

test('a login page left open reloads itself after a release and keeps what was typed', async ({
  page,
}) => {
  await page.clock.install()
  const state = await setup(page)
  await openLogin(page, state)
  await idField(page).fill('TN-04')

  // Overnight a release goes out. Nobody is at the machine, and the page asks nothing.
  state.server = 'released'
  const asked = state.checks
  await page.clock.fastForward('14:00:00')
  await page.waitForTimeout(400)
  expect(state.checks).toBe(asked)
  expect(state.loads).toBe(1)

  // The next morning the study lead comes back to the window.
  await returnToWindow(page)

  await expect.poll(() => state.loads).toBe(2)
  await expect(idField(page)).toHaveValue('TN-04')
  // Nobody pressed anything, so there is nothing to explain.
  await expect(page.getByText(RELOADED)).toHaveCount(0)
  await expect(page.getByText(NOTICE)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('a04.login.kept_id')))
    .toBeNull()

  // On the released files it has no reason to reload again.
  const before = state.checks
  await returnToWindow(page)
  await expect.poll(() => state.checks).toBeGreaterThan(before)
  await page.waitForTimeout(400)
  expect(state.loads).toBe(2)
  expect(await page.evaluate(() => sessionStorage.getItem('a04.reloaded_for'))).toBeNull()
})

test('signing in on an outdated page reloads it first, keeps the ID and then signs in', async ({
  page,
}) => {
  const state = await setup(page)
  await openLogin(page, state)
  await idField(page).fill(PARTICIPANT)
  state.server = 'released'

  await signIn(page).click()

  await expect.poll(() => state.loads).toBe(2)
  await expect(page.getByText(RELOADED)).toBeVisible()
  await expect(idField(page)).toHaveValue(PARTICIPANT)
  // No session was opened on the old page.
  expect(state.logins).toEqual([])
  expect(new URL(page.url()).pathname).toBe('/login')

  await signIn(page).click()
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
  expect(state.logins).toEqual([PARTICIPANT])
  expect(state.loads).toBe(2)
})

test('a reload that does not bring the release happens once, is reported and does not block', async ({
  page,
}) => {
  await page.clock.install()
  const state = await setup(page)
  state.reloadCatchesUp = false
  await openLogin(page, state)
  state.server = 'released'
  await returnToWindow(page)

  await expect.poll(() => state.loads).toBe(2)
  const notice = page.getByRole('status').filter({ hasText: NOTICE })
  await expect(notice).toBeVisible()
  // It does not try again on its own, however often the window is returned to.
  for (let visit = 0; visit < 3; visit++) {
    const before = state.checks
    await returnToWindow(page)
    await expect.poll(() => state.checks).toBeGreaterThan(before)
  }
  await page.waitForTimeout(400)
  expect(state.loads).toBe(2)
  await expect(notice).toBeVisible()
  await expect(notice).toBeInViewport({ ratio: 1 })

  // The study lead can; the page is as it was afterwards.
  await notice.getByRole('button', { name: 'Seite neu laden', exact: true }).click()
  await expect.poll(() => state.loads).toBe(3)
  await expect(notice).toBeVisible()
  await page.waitForTimeout(500)
  expect(state.loads).toBe(3)

  await idField(page).fill(PARTICIPANT)
  await signIn(page).click()
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
  expect(state.logins).toEqual([PARTICIPANT])
  expect(state.loads).toBe(3)
})

test('a server that does not answer the check holds the sign-in up for three seconds at most', async ({
  page,
}) => {
  await page.clock.install()
  const state = await setup(page)
  await openLogin(page, state)
  await idField(page).fill(PARTICIPANT)
  // From here the page's clock moves only when the test moves it.
  await page.clock.pauseAt(new Date(Date.now() + 60_000))
  state.server = 'silent'

  await signIn(page).click()
  await expect(page.getByRole('button', { name: 'Wird geladen…', exact: true })).toBeDisabled()
  await page.clock.runFor(2900)
  await page.waitForTimeout(300)
  expect(state.logins).toEqual([])

  await page.clock.runFor(200)
  await expect.poll(() => state.logins).toEqual([PARTICIPANT])
  // The session's own loading runs on timers again.
  await page.clock.resume()
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
  expect(state.loads).toBe(1)
})

test('a running session is never reloaded, whatever has been released', async ({ page }) => {
  await page.clock.install()
  const state = await setup(page)
  await page.addInitScript((id) => {
    const claims = btoa(JSON.stringify({ sub: id, role: 'participant', exp: 4_000_000_000 }))
    localStorage.setItem('a04_auth', JSON.stringify({ token: `e30.${claims}.test` }))
  }, PARTICIPANT)
  state.server = 'released'
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()

  await page.clock.fastForward('45:00')
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(500)

  expect(state.loads).toBe(1)
  // Only the login page looks; a session's pages do not even ask.
  expect(state.checks).toBe(0)
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
})

test('the notice fits a phone-sized window', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  const state = await setup(page)
  state.reloadCatchesUp = false
  state.server = 'released'
  await page.goto('/login')
  await expect.poll(() => state.loads).toBe(2)
  const notice = page.getByRole('status').filter({ hasText: NOTICE })
  await expect(notice).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
  await expect(notice.getByRole('button', { name: 'Seite neu laden', exact: true })).toBeVisible()
  await expect(signIn(page)).toBeVisible()
})

test('a check answered after the sign-in neither reloads the session nor keeps the ID', async ({
  page,
}) => {
  const state = await setup(page)
  // The server is slow to answer the question the page asks when it opens.
  state.server = 'slow'
  await page.goto('/login')
  await expect(idField(page)).toBeVisible()
  await expect.poll(() => state.slow.length).toBeGreaterThan(0)
  await idField(page).fill(PARTICIPANT)

  // The sign-in's own question is answered at once, and the session opens.
  state.server = 'same'
  await signIn(page).click()
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
  expect(state.logins).toEqual([PARTICIPANT])

  // Only now does the first answer arrive, and it names a newer release.
  for (const route of state.slow)
    await route.fulfill({ contentType: 'text/html', body: RELEASED }).catch(() => {})
  await page.waitForTimeout(800)

  expect(state.loads).toBe(1)
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
  // Nothing is left behind for the next person at this machine.
  expect(
    await page.evaluate(() => [
      sessionStorage.getItem('a04.login.kept_id'),
      sessionStorage.getItem('a04.reloaded_for'),
    ]),
  ).toEqual([null, null])
})

test('when the reload after a sign-in does not help, the page says one thing and keeps the ID', async ({
  page,
}) => {
  const state = await setup(page)
  state.reloadCatchesUp = false
  await openLogin(page, state)
  await idField(page).fill(PARTICIPANT)
  state.server = 'released'

  await signIn(page).click()

  await expect.poll(() => state.loads).toBe(2)
  const notice = page.getByRole('status').filter({ hasText: NOTICE })
  await expect(notice).toBeVisible()
  await expect(idField(page)).toHaveValue(PARTICIPANT)
  // It does not also claim to be up to date.
  await page.waitForTimeout(500)
  await expect(page.getByText(RELOADED)).toHaveCount(0)
  expect(state.logins).toEqual([])

  await notice.getByRole('button', { name: 'Seite neu laden', exact: true }).click()
  await expect.poll(() => state.loads).toBe(3)
  await expect(notice).toBeVisible()
  await expect(idField(page)).toHaveValue(PARTICIPANT)
  await expect(page.getByText(RELOADED)).toHaveCount(0)

  await signIn(page).click()
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
  expect(state.logins).toEqual([PARTICIPANT])
  expect(state.loads).toBe(3)
})
