import { expect, test } from '@playwright/test'

import type { CalibrationRecord } from '../src/api/gaze'

const API = 'http://a04.invalid'
const replies: Record<string, string> = {
  calibrate_start: 'calibration_started',
  calibrate_point: 'calibration_point_result',
  calibrate_compute: 'calibration_result',
}

for (const mode of [
  'none',
  'partial',
  'invalid',
  'valid',
  'right_only',
  'late_discovery',
] as const) {
  test(`calibration validates every target with ${mode} gaze samples`, async ({ page }, info) => {
    await page.addInitScript(() => {
      const payload = { sub: 'CALIBRATION-QA', role: 'participant', exp: 4_000_000_000 }
      localStorage.setItem(
        'a04_auth',
        JSON.stringify({ token: `e30.${btoa(JSON.stringify(payload))}.test` }),
      )
      localStorage.setItem('a04_lang', 'de')
    })
    let current = 0
    const saves: CalibrationRecord[] = []
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
      if (path === '/participant/me')
        return route.fulfill({
          json: { id: 'CALIBRATION-QA', status: 'active', study_name: 'Calibration' },
        })
      if (path === '/participant/session')
        return route.fulfill({
          json: {
            status: 'active',
            current_step_index: current,
            total_steps: 2,
            steps: [
              { index: 0, kind: 'calibration', completed: false },
              { index: 1, kind: 'thanks', completed: false },
            ],
          },
        })
      if (path === '/participant/session/progress') {
        current = request.postDataJSON().current_step_index
        return route.fulfill({
          json: { current_step_index: current, total_steps: 2, complete: false },
        })
      }
      if (path === '/gaze/calibration') {
        saves.push(request.postDataJSON())
        return route.fulfill({ json: { id: saves.length } })
      }
      if (path === '/participant/events') return route.fulfill({ json: { id: 1 } })
      unexpected.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 404, json: { detail: path } })
    })
    let timer: ReturnType<typeof setInterval> | undefined
    await page.routeWebSocket('ws://127.0.0.1:8766', (ws) => {
      ws.send(
        JSON.stringify({
          type: 'status',
          connected: mode !== 'late_discovery',
          frequency: 120,
          display_w_mm: mode === 'late_discovery' ? null : 500,
        }),
      )
      if (mode === 'late_discovery')
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                type: 'status',
                connected: true,
                frequency: 120,
                display_w_mm: 345.4,
                display_h_mm: 194.3,
              }),
            ),
          100,
        )
      ws.onMessage((message) => {
        const type = JSON.parse(String(message)).type as string
        if (replies[type]) ws.send(JSON.stringify({ type: replies[type], ok: true }))
        if (type === 'stop_gaze') clearInterval(timer)
        if (type !== 'start_gaze' || mode === 'none') return
        timer = setInterval(async () => {
          try {
            const point = await page.locator('.calibration__target').evaluate((element) => {
              const box = element.getBoundingClientRect()
              return {
                x: (screenX + (outerWidth - innerWidth) / 2 + box.x + box.width / 2) / screen.width,
                y: (screenY + outerHeight - innerHeight + box.y + box.height / 2) / screen.height,
                top: (element as HTMLElement).style.top,
              }
            })
            if (mode === 'partial' && point.top !== '25%') return
            ws.send(
              JSON.stringify({
                type: 'gaze',
                ts: Date.now(),
                lx: point.x,
                ly: point.y,
                lv: mode !== 'invalid' && mode !== 'right_only',
                rx: mode === 'right_only' ? point.x : null,
                ry: mode === 'right_only' ? point.y : null,
                rv: mode === 'right_only',
                dz: 600,
              }),
            )
          } catch {
            /* The target has just finished. */
          }
        }, 50)
      })
    })
    try {
      await page.goto('/session')
      await page.getByRole('button', { name: 'Kalibrierung starten', exact: true }).click()
      await expect.poll(() => saves.length, { timeout: 20_000 }).toBe(1)
      await page.screenshot({ path: info.outputPath(`calibration-${mode}.png`), fullPage: true })
      expect(saves[0].points).toHaveLength(4)
      if (['valid', 'right_only', 'late_discovery'].includes(mode)) {
        expect(saves[0].status).toBe('success')
        expect(saves[0].points.every((point) => point.samples > 0 && point.offset !== null)).toBe(
          true,
        )
        expect(saves[0].mean_offset).toBeLessThan(0.001)
        await page.getByRole('button', { name: 'Weiter', exact: true }).click()
      } else {
        expect(saves[0].status).toBe('failed')
        expect(saves[0].mean_offset).toBeNull()
        const counts = saves[0].points.map((point) => point.samples)
        if (mode === 'partial') {
          expect(counts.slice(0, 2).every((count) => count > 0)).toBe(true)
          expect(counts.slice(2)).toEqual([0, 0])
        } else expect(counts).toEqual([0, 0, 0, 0])
        await expect(
          page.getByText('Die Kalibrierung ist fehlgeschlagen.', { exact: true }),
        ).toBeVisible()
        await expect(page.getByText(/Mittlere Abweichung/)).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toHaveCount(0)
        await page
          .getByRole('button', { name: 'Ohne Eye-Tracking fortfahren', exact: true })
          .click()
        expect(saves[1].status).toBe('skipped')
      }
      await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
      expect(unexpected).toEqual([])
    } finally {
      clearInterval(timer)
    }
  })
}
