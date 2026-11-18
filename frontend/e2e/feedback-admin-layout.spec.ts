import { expect, test } from '@playwright/test'

import type { AuditRow, GazeRow, ScreenRecordingRow } from '../src/api/admin'
import { expectNoHorizontalOverflow } from './layout'

const API = 'http://a04.invalid'
const participant = 'TEILNEHMER-MIT-EINER-LANGEN-KENNUNG-0123456789'
const title = 'Eine ausführliche Beschreibung der Aufgabe und ihrer Bildschirmaufnahme'
const started = '2026-11-17T09:00:00Z'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const payload = { sub: 'TEST-ADMIN', role: 'admin', exp: 4_000_000_000 }
    localStorage.setItem(
      'a04_auth',
      JSON.stringify({ token: `e30.${btoa(JSON.stringify(payload))}.test` }),
    )
    localStorage.setItem('i18nextLng', 'de')
  })

  const capture: ScreenRecordingRow = {
    id: 5,
    participant_id: participant,
    video_id: 3,
    video_title: title,
    status: 'stored',
    error: null,
    duration_ms: 120_000,
    byte_size: 10_000_000,
    recorder: 'browser',
    audio_status: 'captured',
    epoch_ms: Date.parse(started),
    started_at: started,
  }
  const recording: GazeRow = {
    replay: { kind: 'gaze', id: 1 },
    participant_id: participant,
    video_id: 3,
    video_title: title,
    step_kind: 'case_video',
    sample_count: 7200,
    sampling_rate_hz: 60,
    started_at: started,
    completed_at: null,
    screen: capture,
  }
  const audit: AuditRow = {
    id: 1,
    actor_email: 'researcher.with.a.long.name@example.test',
    action: 'study_updated',
    created_at: started,
    meta: { source: `https://example.test/${'long-path-'.repeat(25)}`, title },
  }
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    const body =
      path === '/admin/gaze/recordings'
        ? { items: [recording] }
        : path === '/admin/screen-recordings'
          ? { items: [capture], total: 1 }
          : path === '/admin/audit'
            ? { items: [audit] }
            : null
    await route.fulfill({
      status: body ? 200 : 404,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      json: body,
    })
  })
})

for (const width of [375, 768, 1366]) {
  test(`recordings keep replay and download actions visible at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/admin/gaze')
    await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeEnabled()
    await expect(
      page.getByRole('button', { name: 'Bildschirmaufnahme herunterladen', exact: true }),
    ).toBeEnabled()
    await expectNoHorizontalOverflow(page)
    await expect(page.locator('.admin-table')).toHaveCount(2)
    for (const table of await page.locator('.admin-table').all()) {
      expect(
        await table.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true)
    }
    await page.screenshot({ path: testInfo.outputPath(`recordings-${width}.png`), fullPage: true })
  })

  test(`audit metadata wraps within the page at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/admin/audit')
    await expect(page.getByRole('cell', { name: 'study_updated', exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    const metadata = page.getByRole('cell').filter({ hasText: 'https://example.test/' })
    expect(
      await metadata.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`audit-${width}.png`), fullPage: true })
  })
}
