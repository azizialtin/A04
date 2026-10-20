import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

import type { SessionStep } from '../src/api/participant'
import type { GazeLayout } from '../src/lib/gazeGeometry'

const API = 'http://a04.invalid'

async function participant(page: Page, kind: 'questionnaire' | 'case_video', failedEvents = true) {
  await page.addInitScript(() => {
    const token = `e30.${btoa(JSON.stringify({ sub: 'TEST-OVERLAY', role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
  })
  const step: SessionStep =
    kind === 'questionnaire'
      ? {
          index: 0,
          completed: false,
          kind,
          questionnaire_id: 4,
          placement: 'pre_test',
          title: 'Fragen für die Browserprüfung',
          section: 'Prüfung',
          video_id: null,
          page: 1,
          page_count: 1,
          questions: Array.from({ length: 10 }, (_, i) => ({
            id: `answer_${i}`,
            type: 'free_text',
            text: `Frage ${i + 1}`,
            required: false,
          })),
        }
      : {
          index: 0,
          completed: false,
          kind,
          video_id: 7,
          title: 'Fall für die Browserprüfung',
          task_description: 'Beobachten Sie den Fall.',
          info_text: 'Information zum Fall.',
          student_task_text: 'Die Schülerinnen und Schüler bearbeiten eine Aufgabe.',
          time_limit_seconds: 600,
        }
  const layouts: GazeLayout[] = []
  const unexpected: string[] = []
  let recording = 0
  await page.routeWebSocket('ws://127.0.0.1:8766', (ws) => {
    ws.send(
      JSON.stringify({ type: 'status', connected: true, frequency: 120, screen_recording: false }),
    )
  })
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, json: value, headers: { 'Access-Control-Allow-Origin': '*' } })
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
      })
    if (path === '/participant/me') return json({ id: 'TEST-OVERLAY', status: 'active' })
    if (path === '/participant/session')
      return json({ status: 'active', current_step_index: 0, total_steps: 1, steps: [step] })
    if (path === '/participant/events') return json({}, failedEvents ? 503 : 200)
    if (path.endsWith('/respond')) return json({ detail: 'Synthetic submission failure' }, 503)
    if (path.endsWith('/notes')) return json([])
    if (path.endsWith('/url')) return json({ signed_url: `${API}/stimulus.webm` })
    if (path === '/stimulus.webm')
      return route.fulfill({
        contentType: 'video/webm',
        body: await readFile(new URL('./fixtures/stimulus.webm', import.meta.url)),
      })
    if (path === '/gaze/recordings') {
      layouts.push(request.postDataJSON().geometry)
      return json({ recording_id: ++recording }, 201)
    }
    if (/^\/gaze\/recordings\/\d+\/geometry$/.test(path)) {
      layouts.push(request.postDataJSON())
      return json({ status: 'ok' }, 202)
    }
    if (/^\/gaze\/recordings\/\d+\/(samples|complete)$/.test(path)) return json({ status: 'ok' })
    unexpected.push(`${request.method()} ${path}`)
    return json({ detail: 'Unexpected test request' }, 400)
  })
  await page.goto('/session')
  await expect.poll(() => layouts.length).toBeGreaterThan(0)
  return { latest: () => layouts.at(-1)!, unexpected }
}

function labelAt(layout: GazeLayout, point: { x: number; y: number }) {
  return layout.aois
    ?.map((area, index) => ({ ...area, index }))
    .filter(
      (area) =>
        point.x >= area.x &&
        point.x < area.x + area.w &&
        point.y >= area.y &&
        point.y < area.y + area.h,
    )
    .sort((a, b) => b.priority - a.priority || b.index - a.index)[0]?.id
}

async function center(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

async function visibleId(page: Page, point: { x: number; y: number }) {
  return page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-aoi]')?.dataset.aoi,
    point,
  )
}

async function screenshot(page: Page, layout: GazeLayout, info: TestInfo, name: string) {
  await writeFile(info.outputPath(`${name}-layout.json`), JSON.stringify(layout, null, 2))
  await page.evaluate((areas) => {
    for (const area of areas ?? []) {
      const box = document.createElement('div')
      box.dataset.overlayVerification = ''
      box.textContent = area.id
      Object.assign(box.style, {
        position: 'fixed',
        left: `${area.x}px`,
        top: `${area.y}px`,
        width: `${area.w}px`,
        height: `${area.h}px`,
        boxSizing: 'border-box',
        border: '1px solid red',
        background: 'rgba(255, 0, 0, .13)',
        color: '#9d0015',
        font: '11px monospace',
        zIndex: '2147483647',
        pointerEvents: 'none',
      })
      document.body.append(box)
    }
  }, layout.aois)
  await page.screenshot({ path: info.outputPath(`${name}-red.png`) })
  await page
    .locator('[data-overlay-verification]')
    .evaluateAll((boxes) => boxes.forEach((box) => box.remove()))
  await page.screenshot({ path: info.outputPath(`${name}-clean.png`) })
}

test('a real unsent notice wins over a covered answer but stays behind the supervisor modal', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const data = await participant(page, 'questionnaire')
  await expect(page.locator('.unsent')).toBeVisible()
  await page.locator('[data-aoi="question.answer_4.answer"]').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    window.scrollBy(0, rect.top - (innerHeight - 100))
  })
  const point = await center(page, '.unsent')
  await expect.poll(() => labelAt(data.latest(), point)).toBe('unsent_notice')
  expect(await visibleId(page, point)).toBe('unsent_notice')
  // Establish that this is a real occlusion, not a banner over empty page space.
  expect(
    data
      .latest()
      .aois?.some(
        (a) =>
          a.id === 'question.answer_4.answer' &&
          point.x >= a.x &&
          point.x < a.x + a.w &&
          point.y >= a.y &&
          point.y < a.y + a.h,
      ),
  ).toBe(true)
  await screenshot(page, data.latest(), info, 'unsent-over-answer')

  await page.keyboard.press('Control+Alt+Shift+KeyB')
  await expect.poll(() => data.latest().active_modal).toBe('supervisor_dialog')
  expect(data.latest().aois?.map((a) => a.id)).toEqual(['supervisor_dialog'])
  expect(
    await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[aria-modal="true"]')),
      point,
    ),
  ).toBe(true)
  await screenshot(page, data.latest(), info, 'supervisor-covers-unsent')
  expect(data.unexpected).toEqual([])
})

test('the actual failure toast is measured and is excluded behind a modal backdrop', async ({
  page,
}, info) => {
  const data = await participant(page, 'questionnaire', false)
  await page.locator('[data-aoi="continue"]').click()
  await expect(page.locator('.toast')).toBeVisible()
  const point = await center(page, '.toast')
  await expect.poll(() => labelAt(data.latest(), point)).toBe('notification')
  expect(await visibleId(page, point)).toBe('notification')
  expect(data.latest().aois?.filter((a) => a.id === 'notification')).toHaveLength(1)
  await screenshot(page, data.latest(), info, 'notification')
  await page.keyboard.press('Control+Alt+Shift+KeyB')
  await expect.poll(() => data.latest().active_modal).toBe('supervisor_dialog')
  expect(data.latest().aois?.map((a) => a.id)).toEqual(['supervisor_dialog'])
  expect(data.unexpected).toEqual([])
})

test('a later same-z unsent notice remains visible above the case modal', async ({
  page,
}, info) => {
  const data = await participant(page, 'case_video')
  await expect(page.locator('.unsent')).toBeVisible()
  await page.locator('[data-aoi="student_task_button"]').click()
  await expect.poll(() => data.latest().active_modal).toBe('student_task_dialog')
  const point = await center(page, '.unsent')
  expect(await visibleId(page, point)).toBe('unsent_notice')
  expect(labelAt(data.latest(), point)).toBe('unsent_notice')
  expect(data.latest().aois?.map((a) => a.id)).toEqual(['student_task_dialog', 'unsent_notice'])
  await screenshot(page, data.latest(), info, 'unsent-above-case-modal')
  expect(data.unexpected).toEqual([])
})
