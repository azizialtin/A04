import { expect, test } from '@playwright/test'

const API = 'http://a04.invalid'

test('study and participant creation controls have accessible names and submit their values', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const payload = { sub: 'ADMIN-QA', role: 'admin', exp: 4_000_000_000 }
    localStorage.setItem(
      'a04_auth',
      JSON.stringify({ token: `e30.${btoa(JSON.stringify(payload))}.test` }),
    )
  })
  const study = {
    id: 8,
    name: 'Accessible study',
    description: '',
    is_active: true,
    flow_version: 'pilot_20261116',
    think_aloud_mode: 'bundled',
    think_aloud_count: 3,
    think_aloud_batch_size: 1,
    sosci_pretest_url: '',
    sosci_posttest_url: '',
    sosci_id_param: 'id',
    texts: {},
    video_defaults: { time_limit_seconds: null, task_description: '', info_text: '' },
  }
  let created = false
  const writes: { path: string; body: unknown }[] = []
  const unexpected: string[] = []
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
    if (path === '/admin/studies') {
      if (request.method() === 'POST') {
        writes.push({ path, body: request.postDataJSON() })
        created = true
        return route.fulfill({ json: study })
      }
      return route.fulfill({ json: created ? [study] : [] })
    }
    if (path === '/admin/studies/8') return route.fulfill({ json: study })
    if (path === '/admin/studies/8/participants') {
      if (request.method() === 'POST') {
        writes.push({ path, body: request.postDataJSON() })
        return route.fulfill({ json: { created: request.postDataJSON().ids, skipped: [] } })
      }
      return route.fulfill({ json: [] })
    }
    if (path === '/admin/studies/8/videos') return route.fulfill({ json: [] })
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { detail: path } })
  })
  await page.goto('/admin/studies')
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(study.name)
  await page
    .getByRole('textbox', { name: 'SoSci-Link (Vortest)', exact: true })
    .fill('https://example.test/pre')
  await page
    .getByRole('textbox', { name: 'SoSci-Link (Nachtest)', exact: true })
    .fill('https://example.test/post')
  await page.getByRole('button', { name: 'Anlegen', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Öffnen', exact: true })).toBeVisible()
  expect(writes[0]).toEqual({
    path: '/admin/studies',
    body: {
      name: study.name,
      sosci_pretest_url: 'https://example.test/pre',
      sosci_posttest_url: 'https://example.test/post',
    },
  })
  await page.goto('/admin/studies/8?tab=participants')
  await page.getByRole('textbox', { name: 'ID-Präfix', exact: true }).fill('QA-')
  await page.getByRole('spinbutton', { name: 'Anzahl der IDs', exact: true }).fill('2')
  await page.getByRole('checkbox', { name: /Fortlaufend nummerieren/ }).check()
  await page.getByRole('button', { name: 'IDs erzeugen', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'IDs (eine pro Zeile)', exact: true }),
  ).toHaveValue('QA-001\nQA-002')
  await page.getByRole('button', { name: 'Anlegen', exact: true }).click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toEqual({
    path: '/admin/studies/8/participants',
    body: { ids: ['QA-001', 'QA-002'] },
  })
  expect(unexpected).toEqual([])
})
