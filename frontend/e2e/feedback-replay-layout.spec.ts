import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFileSync } from 'node:fs'

import type { ReplayData, SessionStep } from '../src/api/participant'

const API = 'http://a04.invalid'
const clip = readFileSync(new URL('./fixtures/stimulus.webm', import.meta.url))
const scenarios = [
  { name: 'healthy recording', source: 'screen', points: 10, audio: 'captured', warnings: 0 },
  { name: 'no gaze', source: 'screen', points: 0, audio: 'captured', warnings: 1 },
  { name: 'missing audio', source: 'screen', points: 10, audio: 'failed', warnings: 1 },
  { name: 'no gaze and missing audio', source: 'screen', points: 0, audio: 'failed', warnings: 2 },
  { name: 'clip fallback without gaze', source: 'clip', points: 0, audio: 'unknown', warnings: 1 },
  { name: 'clip fallback with gaze', source: 'clip', points: 10, audio: 'unknown', warnings: 0 },
] as const

async function openReplay(
  page: Page,
  scenario: (typeof scenarios)[number],
  viewport = { width: 1920, height: 1080 },
) {
  await page.setViewportSize(viewport)
  await page.addInitScript(() => {
    const token = `e30.${btoa(JSON.stringify({ sub: 'REPLAY-LAYOUT', role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
    localStorage.setItem('i18nextLng', 'de')
  })
  const step: SessionStep = {
    index: 0,
    completed: false,
    kind: 'think_aloud',
    video_id: 1,
    phase_type: 'training',
    case_number: 5,
    case_total: 7,
    batch_position: 1,
    batch_size: 3,
    heading: '',
    body: '',
  }
  const replay: ReplayData = {
    video_url: `${API}/stimulus.webm`,
    source: scenario.source,
    recording_pending: false,
    sampling_rate_hz: 120,
    plotted_points: scenario.points,
    invalid_samples: 0,
    unmapped_samples: 0,
    offscreen_samples: 0,
    has_geometry: true,
    points: scenario.points ? [{ t: 0, x: 0.5, y: 0.5 }] : [],
    epoch_ms: scenario.source === 'screen' ? Date.now() : null,
    duration_ms: 2000,
    recorder: scenario.source === 'screen' ? 'browser' : null,
    audio_status: scenario.audio,
  }
  let current = 0
  const unexpected: string[] = []
  await page.route(`${API}/**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    const json = (value: unknown) => route.fulfill({ json: value })
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
      return json({ id: 'REPLAY-LAYOUT', status: 'active', study_name: 'Replay layout' })
    if (path === '/participant/session')
      return json({
        flow_version: 'pilot_20261116',
        status: 'active',
        current_step_index: current,
        total_steps: 2,
        steps: [step, { index: 1, completed: false, kind: 'thanks' }],
      })
    if (path === '/participant/session/progress') {
      current = request.postDataJSON().current_step_index
      return json({ current_step_index: current, total_steps: 2, complete: false })
    }
    if (path.endsWith('/notes')) return json([])
    if (path === '/gaze/videos/1/replay') return json(replay)
    if (path === '/stimulus.webm')
      return route.fulfill({ status: 200, contentType: 'video/webm', body: clip })
    if (path === '/participant/events') return json({ id: 1 })
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { detail: path } })
  })
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Lautes Denken 1 von 3' })).toBeVisible()
  await expect(page.getByText('Erörterungs-Phase · Fall 5 von 7', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Sie sehen nun nacheinander die Aufzeichnungen der letzten 3 Fälle.'),
  ).toBeVisible()
  await expect(page.locator('.think-aloud > [role="status"]')).toHaveCount(scenario.warnings)
  const fallback = page.locator('.think-aloud__head [role="status"]')
  await expect(fallback).toHaveCount(scenario.source === 'clip' ? 1 : 0)
  if (scenario.source === 'clip') {
    await expect(fallback).toHaveText('nur das Video (keine Bildschirmaufzeichnung)')
    await expect(fallback).toBeInViewport({ ratio: 1 })
    const notice = await fallback.boundingBox()
    const instructions = await page
      .locator('.think-aloud__head > p.muted:not(.small)')
      .first()
      .boundingBox()
    expect(notice!.y + notice!.height).toBeLessThanOrEqual(instructions!.y)
  }
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThan(0)
  await page.evaluate(() => document.fonts.ready)
  // The participant talks over the recording, so every replay starts at 30 %.
  const sound = await page
    .locator('video')
    .evaluate((video: HTMLVideoElement) => ({ volume: video.volume, muted: video.muted }))
  expect(sound.volume).toBeCloseTo(0.3, 5)
  expect(sound.muted).toBe(false)
  return unexpected
}

async function assertViewport(page: Page, info: TestInfo) {
  const metrics = await page.evaluate(() => {
    const elements = [
      ...document.querySelectorAll<HTMLElement>(
        '.think-aloud__head, .think-aloud > [role="status"], .replay__stage, .replay__toggle, .think-aloud__foot, .think-aloud__foot button',
      ),
    ]
    const outside = elements
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.top < 0 || box.left < 0 || box.bottom > innerHeight + 1 || box.right > innerWidth + 1
        )
      })
      .map((element) => element.className)
    const scrollers = elements
      .filter(
        (element) =>
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1,
      )
      .map((element) => element.className)
    const video = document.querySelector<HTMLVideoElement>('.replay__video')!
    const stage = document.querySelector('.replay__stage')!.getBoundingClientRect()
    return {
      width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      scrollY,
      outside,
      scrollers,
      stage: { width: stage.width, height: stage.height },
      stageAspect: stage.width / stage.height,
      videoAspect: video.videoWidth / video.videoHeight,
    }
  })
  await info.attach('viewport', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  await page.screenshot({ path: info.outputPath('replay.png'), fullPage: true })
  expect(metrics).toMatchObject({
    width: 1920,
    height: 1080,
    scrollY: 0,
    outside: [],
    scrollers: [],
  })
  expect(metrics.stageAspect).toBeCloseTo(metrics.videoAspect, 2)
  expect(metrics.stage.height).toBeGreaterThan(600)
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeInViewport({
    ratio: 1,
  })
}

for (const scenario of scenarios) {
  test(`first bundled replay fits the lab viewport: ${scenario.name}`, async ({ page }, info) => {
    const unexpected = await openReplay(page, scenario)
    await assertViewport(page, info)
    await expect(page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' })).toBeChecked()
    await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).uncheck()
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
    expect(unexpected).toEqual([])
  })
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 1366, height: 600 },
]) {
  test(`replay controls remain reachable at ${viewport.width}×${viewport.height}`, async ({
    page,
  }, info) => {
    const unexpected = await openReplay(page, scenarios[3], viewport)
    const metrics = await page.locator('.replay__stage').evaluate((element) => {
      const video = element.querySelector<HTMLVideoElement>('video')!
      const stage = element.getBoundingClientRect()
      return {
        width: stage.width,
        height: stage.height,
        videoAspect: video.videoWidth / video.videoHeight,
        pageWidth: document.documentElement.scrollWidth,
      }
    })
    expect(metrics.height).toBeGreaterThan(100)
    expect(metrics.width / metrics.height).toBeCloseTo(metrics.videoAspect, 2)
    expect(metrics.pageWidth).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: info.outputPath('replay.png'), fullPage: true })
    const fullscreen = page.getByRole('button', { name: 'Vollbild', exact: true })
    await fullscreen.scrollIntoViewIfNeeded()
    await expect(fullscreen).toBeInViewport({ ratio: 1 })
    await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).uncheck()
    const next = page.getByRole('button', { name: 'Weiter', exact: true })
    // Chromium can round nearest-edge scrolling down, leaving a fractional
    // pixel below the viewport. Center-scroll through the page's available
    // space, then still require the entire control to be visible and usable.
    await next.evaluate((button) => button.scrollIntoView({ block: 'center', inline: 'nearest' }))
    await expect(next).toBeInViewport({ ratio: 1 })
    await next.click()
    await expect(page.getByRole('heading', { name: 'Vielen Dank!', exact: true })).toBeVisible()
    expect(unexpected).toEqual([])
  })
}

test('the replay volume starts at 30 % and then stays where the participant sets it', async ({
  page,
}) => {
  await openReplay(page, scenarios[0])
  const video = page.locator('video')
  await video.evaluate((element: HTMLVideoElement) => {
    element.volume = 0.85
  })
  // Hiding and showing the gaze dot re-renders the player around the same element.
  await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).uncheck()
  await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).check()
  expect(await video.evaluate((element: HTMLVideoElement) => element.volume)).toBeCloseTo(0.85, 5)
  // Playing does not reset it either.
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true
    await element.play()
    element.pause()
    element.muted = false
  })
  expect(await video.evaluate((element: HTMLVideoElement) => element.volume)).toBeCloseTo(0.85, 5)
})
