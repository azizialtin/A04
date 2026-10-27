import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const API = 'http://a04.invalid'
const fixture = fileURLToPath(new URL('./fixtures/stimulus.webm', import.meta.url))

async function setup(page: Page) {
  await page.addInitScript(() => {
    const payload = { sub: 'TEST-ADMIN', role: 'admin', exp: 4_000_000_000 }
    localStorage.setItem(
      'a04_auth',
      JSON.stringify({ token: `e30.${btoa(JSON.stringify(payload))}.test` }),
    )
  })
  const unexpected: string[] = []
  const requested: string[] = []
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (path === '/admin/studies/8') {
      return route.fulfill({
        headers,
        json: {
          id: 8,
          name: 'Download-Prüfung',
          is_active: true,
          description: '',
          texts: {},
          video_defaults: { time_limit_seconds: null, task_description: '', info_text: '' },
        },
      })
    }
    if (path === '/admin/studies/8/videos') {
      return route.fulfill({
        headers,
        json: [
          { id: 13, title: 'Java-Beispiel', phase_type: 'training', has_file: true },
          { id: 14, title: 'Ohne Datei', phase_type: 'training', has_file: false },
        ],
      })
    }
    if (path === '/admin/gaze/recordings') return route.fulfill({ headers, json: { items: [] } })
    if (path === '/admin/screen-recordings') {
      return route.fulfill({
        headers,
        json: {
          total: 3,
          items: [21, 22, 23].map((id) => ({
            id,
            participant_id: 'TEST-P001',
            video_id: 13,
            video_title: 'Java-Beispiel',
            status: id === 23 ? 'failed' : 'stored',
            error: null,
            duration_ms: 60000,
            byte_size: 1000000,
            recorder: 'browser',
            epoch_ms: 1_700_000_000_000,
            started_at: `2026-10-27T10:${id}:00Z`,
          })),
        },
      })
    }
    if (path.endsWith('/download-url')) {
      requested.push(path)
      if (path === '/admin/screen-recordings/22/download-url') {
        return route.fulfill({ status: 503, headers, json: { detail: 'Storage unavailable' } })
      }
      const id = path.split('/').at(-2)
      return route.fulfill({
        headers,
        json: { url: `${API}/attachments/${id}`, filename: `capture-${id}.webm` },
      })
    }
    if (path.startsWith('/attachments/')) {
      const id = path.split('/').at(-1)
      return route.fulfill({
        path: fixture,
        headers: { ...headers, 'Content-Disposition': `attachment; filename="capture-${id}.webm"` },
      })
    }
    unexpected.push(path)
    return route.fulfill({ status: 404, headers })
  })
  return { unexpected, requested }
}

test('study videos download through the native browser without navigating away', async ({
  page,
}, info) => {
  const { unexpected, requested } = await setup(page)
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.goto('/admin/studies/8?tab=videos')
  const buttons = page.getByRole('button', { name: 'Stimulus herunterladen' })
  await expect(buttons.first()).toBeEnabled()
  await expect(buttons.nth(1)).toBeDisabled()
  await page.screenshot({ path: info.outputPath('stimulus-download-page.png'), fullPage: true })
  const completed = page.waitForEvent('download')
  await buttons.first().click()
  const download = await completed
  expect(download.suggestedFilename()).toBe('capture-13.webm')
  const path = info.outputPath('downloaded-stimulus.webm')
  await download.saveAs(path)
  expect(await readFile(path)).toEqual(await readFile(fixture))
  await expect(page).toHaveURL(/tab=videos/)
  expect(requested).toEqual(['/admin/videos/13/download-url'])
  expect(unexpected).toEqual([])
})

test('recordings expose each repeated capture and show unavailable download errors', async ({
  page,
}, info) => {
  const { unexpected, requested } = await setup(page)
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.goto('/admin/gaze')
  const buttons = page.getByRole('button', { name: 'Bildschirmaufnahme herunterladen' })
  await expect(buttons).toHaveCount(3)
  await expect(buttons.nth(2)).toBeDisabled()
  await page.screenshot({ path: info.outputPath('screen-download-page.png'), fullPage: true })
  const completed = page.waitForEvent('download')
  await buttons.first().click()
  const download = await completed
  expect(download.suggestedFilename()).toBe('capture-21.webm')
  await buttons.nth(1).click()
  await expect(page.getByText('Download nicht verfügbar. Bitte erneut versuchen.')).toBeVisible()
  expect(requested).toEqual([
    '/admin/screen-recordings/21/download-url',
    '/admin/screen-recordings/22/download-url',
  ])
  expect(unexpected).toEqual([])
})
