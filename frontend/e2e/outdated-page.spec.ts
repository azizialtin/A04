import { expect, test, type APIRequestContext } from '@playwright/test'

const API = process.env.E2E_API_URL ?? 'http://localhost:8031'

async function seed(request: APIRequestContext) {
  const login = await request.post(`${API}/auth/admin/login`, {
    data: {
      email: process.env.E2E_ADMIN_EMAIL ?? 'e2e@a04.test',
      password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password-1234',
    },
  })
  expect(login.ok(), await login.text()).toBeTruthy()
  const headers = { Authorization: `Bearer ${(await login.json()).access_token}` }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const study = await request.post(`${API}/admin/studies`, {
    headers,
    data: { name: `Outdated page ${stamp}` },
  })
  expect(study.ok(), await study.text()).toBeTruthy()
  const studyId = (await study.json()).id as number
  const participantId = `RELOAD-${stamp}`
  const created = await request.post(`${API}/admin/studies/${studyId}/participants`, {
    headers,
    data: { ids: [participantId] },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const status = async () => {
    const list = await request.get(`${API}/admin/studies/${studyId}/participants`, { headers })
    const rows = (await list.json()) as { id: string; status: string }[]
    return rows.find((row) => row.id === participantId)?.status
  }
  return { participantId, status }
}

// The built page, as the lab loads it: its shell names files by their content.
test('a built login page knows it is current, and reloads before a sign-in once it is not', async ({
  page,
  request,
}) => {
  const { participantId, status } = await seed(request)
  let server: 'same' | 'released' = 'same'
  let checks = 0
  let loads = 0
  page.on('load', () => loads++)
  let documents = 0
  page.on('request', (request) => {
    // The reload brings the tab onto what the server has. The router also
    // navigates within the page; only a new document is a reload.
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return
    if (++documents > 1) server = 'same'
  })
  await page.route('**/index.html', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue()
    checks++
    if (server === 'same') return route.continue()
    // The same shell after a release: the script has a new name.
    const response = await route.fetch()
    const shell = (await response.text()).replace(/index-[\w-]+\.js/, 'index-NextRelease.js')
    return route.fulfill({ response, body: shell })
  })

  await page.goto('/login')
  const id = page.getByLabel('Teilnehmer-ID')
  await expect(id).toBeVisible()
  await expect.poll(() => checks).toBeGreaterThan(0)
  const shell = await (await request.get('/index.html')).text()
  expect(shell).toMatch(/<script type="module"[^>]*src="\/assets\/index-[\w-]+\.js"/)
  expect(shell).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/index-[\w-]+\.css"/)
  await page.waitForTimeout(700)
  expect(loads).toBe(1)
  await expect(page.getByText('nicht auf dem neuesten Stand', { exact: false })).toHaveCount(0)

  await id.fill(participantId)
  server = 'released'
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()

  await expect.poll(() => loads).toBe(2)
  await expect(
    page.getByText('Die Seite wurde auf den neuesten Stand gebracht.', { exact: false }),
  ).toBeVisible()
  await expect(id).toHaveValue(participantId)
  // The run has not begun: the old page never reached the sign-in.
  expect(await status()).toBe('registered')

  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible()
  await expect(page.getByText(participantId, { exact: true })).toBeVisible()
  expect(loads).toBe(2)
  expect(await status()).toBe('active')
})
