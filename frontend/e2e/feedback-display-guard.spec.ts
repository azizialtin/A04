import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import type { SessionStep } from '../src/api/participant'
import type { Question } from '../src/lib/questionnaire'

const API = 'http://a04.invalid'
const PARTICIPANT = 'QA-DISPLAY-GUARD'
const RESUME = 'Studienleitung: Fortsetzen'
const DIALOG = 'Bildschirmeinstellung prüfen'
const clip = readFileSync(new URL('./fixtures/stimulus.webm', import.meta.url))
type SourcePage = { source_task: number; title: string; description: string; questions: Question[] }
const manifest = JSON.parse(
  readFileSync(
    new URL('../../backend/app/data/pretest_pilot20261116.json', import.meta.url),
    'utf8',
  ),
) as {
  ck_tasks: { question: Question }[]
  pck_pages: SourcePage[]
  mesp_pages: SourcePage[]
  mesp_intro: { title: string; body: string }
}

function questionnaire(index = 0, ck = false): SessionStep {
  return {
    kind: 'questionnaire',
    index,
    completed: false,
    questionnaire_id: index + 1,
    placement: 'pre_test',
    title: ck ? 'CK: Aufgabe 1' : `Prüfseite ${index + 1}`,
    description: '',
    section: ck ? 'CK' : 'PCK',
    section_key: ck ? 'ck_tasks' : 'pck',
    video_id: null,
    page: 1,
    page_count: 1,
    questions: ck
      ? [manifest.ck_tasks[0].question]
      : [{ id: `answer_${index}`, type: 'free_text', text: 'Ihre Antwort', required: true }],
  }
}

async function setup(page: Page, steps: SessionStep[], ckDuration = 420_000) {
  const state = {
    current: 0,
    visits: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    responses: [] as Record<string, unknown>[],
    finishes: [] as Record<string, unknown>[],
    recordings: [] as Record<string, unknown>[],
    layouts: [] as Record<string, unknown>[],
    samples: [] as { ts: number; geometry_ts: number | null; lpd?: number; rpd?: number }[],
    commands: [] as string[],
    screenStarts: 0,
    unexpected: [] as string[],
    timing: null as null | {
      section_key: string
      duration_seconds: number
      deadline_ms: number
      server_now_ms: number
      finished: boolean
      started_client_ts: number
      ended_client_ts: null
    },
  }
  await page.addInitScript((id) => {
    const token = `e30.${btoa(JSON.stringify({ sub: id, role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
    localStorage.setItem('i18nextLng', 'de')
  }, PARTICIPANT)
  await page.routeWebSocket('ws://127.0.0.1:8766', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'status',
        connected: true,
        frequency: 120,
        screen_recording: true,
        stimulus_audio: false,
        screen_width_mm: 345.35,
        screen_height_mm: 194.26,
      }),
    )
    let timer: ReturnType<typeof setInterval> | undefined
    socket.onMessage((message) => {
      const command = JSON.parse(String(message)).type as string
      state.commands.push(command)
      if (command === 'start_gaze' && !timer)
        timer = setInterval(
          () =>
            socket.send(
              JSON.stringify({
                type: 'gaze',
                ts: Date.now(),
                lx: 0.5,
                ly: 0.5,
                rx: 0.5,
                ry: 0.5,
                lv: true,
                rv: true,
                lpd: 3.2,
                rpd: 3.3,
              }),
            ),
          25,
        )
      if (command === 'stop_gaze') {
        clearInterval(timer)
        timer = undefined
      }
      if (command === 'start_screen_recording')
        socket.send(JSON.stringify({ type: 'screen_recording_started', ok: true }))
    })
    socket.onClose(() => clearInterval(timer))
  })
  const progress = () => ({
    current_step_index: state.current,
    total_steps: steps.length,
    status: 'active',
    complete: false,
  })
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
    if (path === '/participant/me') return json({ id: PARTICIPANT, status: 'active' })
    if (path === '/participant/session')
      return json({
        ...progress(),
        flow_version: 'pilot_20261116',
        steps,
        section_timing: state.timing,
      })
    if (path === '/participant/session/questionnaire-visit') {
      const body = request.postDataJSON()
      state.visits.push(body)
      const step = steps[state.current]
      if (step.kind === 'questionnaire' && step.section_key === 'ck_tasks' && !state.timing) {
        const now = Date.now()
        state.timing = {
          section_key: 'ck_tasks',
          duration_seconds: 420,
          deadline_ms: now + ckDuration,
          server_now_ms: now,
          finished: false,
          started_client_ts: now,
          ended_client_ts: null,
        }
      }
      return json({ visit_id: body.visit_id, section_timing: state.timing })
    }
    if (path === '/participant/session/finish-ck') {
      state.finishes.push(request.postDataJSON())
      state.current += 1
      if (state.timing) state.timing.finished = true
      return json(progress())
    }
    if (/^\/participant\/questionnaires\/\d+\/respond$/.test(path)) {
      state.responses.push(request.postDataJSON())
      state.current += 1
      return json(progress())
    }
    if (path === '/participant/session/progress') {
      state.current = request.postDataJSON().current_step_index
      return json(progress())
    }
    if (path === '/participant/events') {
      state.events.push(request.postDataJSON())
      return json({ id: 1 })
    }
    if (path === '/participant/notes') return json({ id: 1 })
    if (path.endsWith('/notes')) return json([])
    if (path.endsWith('/url')) return json({ signed_url: `${API}/stimulus.webm` })
    if (path === '/stimulus.webm') return route.fulfill({ contentType: 'video/webm', body: clip })
    if (path === '/gaze/recordings') {
      state.recordings.push(request.postDataJSON())
      return json({ recording_id: state.recordings.length })
    }
    if (/^\/gaze\/recordings\/\d+\/geometry$/.test(path)) {
      state.layouts.push(request.postDataJSON())
      return json({ status: 'ok' })
    }
    if (/^\/gaze\/recordings\/\d+\/samples$/.test(path)) {
      state.samples.push(...request.postDataJSON().samples)
      return json({ status: 'ok' })
    }
    if (/^\/gaze\/recordings\/\d+\/complete$/.test(path)) return json({ status: 'ok' })
    if (path === '/screen/recordings') {
      state.screenStarts += 1
      return json({ recording_id: state.screenStarts, upload_token: 'synthetic-capture-only' })
    }
    if (/^\/screen\/recordings\/\d+\/heartbeat$/.test(path)) return json({ status: 'ok' })
    state.unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 400, json: { detail: 'Unexpected test request' } })
  })
  return state
}

async function resume(page: Page) {
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  await expect(page.getByRole('button', { name: RESUME })).toBeEnabled()
  await page.getByRole('button', { name: RESUME }).click()
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
}

test('initial verification gates visits and capture; ordinary page changes retain verification', async ({
  page,
}) => {
  const state = await setup(page, [questionnaire(), questionnaire(1)])
  await page.goto('/session')
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  expect(state.visits).toHaveLength(0)
  expect(state.recordings).toHaveLength(0)
  await expect(page.locator('textarea')).toHaveCount(0)
  // Exercise real browser fullscreen; full-screen geometry also supports F11.
  await page.getByRole('button', { name: 'Vollbild öffnen' }).click()
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  await expect(page.getByRole('button', { name: RESUME })).toBeEnabled()
  expect(state.visits).toHaveLength(0)
  expect(state.recordings).toHaveLength(0)
  await resume(page)
  await expect.poll(() => state.visits.length).toBe(1)
  await page.locator('textarea').fill('Gesicherter Entwurf')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
  await expect.poll(() => state.visits.length).toBe(2)
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  expect(state.responses[0]).toMatchObject({ answers: { answer_0: 'Gesicherter Entwurf' } })
  expect(state.unexpected).toEqual([])
})

for (const disturbance of ['resize', 'windowed', 'zoom', 'display scale'] as const) {
  test(`${disturbance} blocks input; restoration requires confirmation and preserves the same draft and visit`, async ({
    page,
    context,
  }) => {
    const state = await setup(page, [questionnaire()])
    await page.goto('/session')
    await resume(page)
    await page.locator('textarea').fill('Mein unveränderter Entwurf')
    await expect.poll(() => state.visits.length).toBe(1)
    const visit = state.visits[0].visit_id
    const cdp = await context.newCDPSession(page)
    let restore: () => Promise<unknown>
    if (disturbance === 'resize') {
      await page.setViewportSize({ width: 1600, height: 900 })
      restore = () => page.setViewportSize({ width: 1920, height: 1080 })
    } else if (disturbance === 'windowed') {
      // F11 is browser chrome, outside DOM fullscreen. Exercise its measurable
      // effect with the browser window, leaving the page viewport unchanged.
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1600, height: 900 } })
      restore = () =>
        cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1920, height: 1080 } })
    } else if (disturbance === 'zoom') {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 })
      expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1.25)
      restore = () => cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
    } else {
      const metrics = {
        width: 1920,
        height: 1080,
        screenWidth: 1920,
        screenHeight: 1080,
        mobile: false,
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...metrics, deviceScaleFactor: 1.25 })
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.25)
      restore = () =>
        cdp.send('Emulation.setDeviceMetricsOverride', { ...metrics, deviceScaleFactor: 1 })
    }
    await expect(page.locator('[data-display-guard]')).toHaveAttribute(
      'data-display-guard',
      'blocked',
    )
    await expect(page.getByRole('button', { name: RESUME })).toBeDisabled()
    expect(await page.locator('textarea').evaluate((el) => Boolean(el.closest('[inert]')))).toBe(
      true,
    )
    const restoredAt = Date.now()
    await restore()
    await expect(page.locator('[data-display-guard]')).toHaveAttribute(
      'data-display-guard',
      'ready',
    )
    expect(Date.now() - restoredAt).toBeGreaterThanOrEqual(450)
    await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
    expect(state.visits).toHaveLength(1)
    expect(state.responses).toHaveLength(0)
    await resume(page)
    await expect(page.locator('textarea')).toHaveValue('Mein unveränderter Entwurf')
    expect(state.visits).toHaveLength(1)
    expect(state.visits[0].visit_id).toBe(visit)
    await expect
      .poll(
        () => state.events.filter((event) => event.event_type === 'display_guard_resumed').length,
      )
      .toBe(2)
    const interruption = state.events
      .filter((event) => event.event_type === 'display_guard_interrupted')
      .at(-1)!
    const payload = interruption.payload as {
      profile: string
      detected_at: number
      reasons: string[]
    }
    expect(payload.profile).toBe('lab_1080p')
    const relevantReasons = {
      resize: ['window_size'],
      windowed: ['window_size'],
      // A resize event can revoke verification before the zoom metric is read.
      zoom: ['viewport_zoom', 'window_size'],
      'display scale': ['display_scale', 'window_size'],
    }[disturbance]
    expect(payload.reasons.some((reason) => relevantReasons.includes(reason))).toBe(true)
    expect(interruption.client_ts as number).toBeLessThanOrEqual(payload.detected_at)
    expect(
      state.events
        .filter((event) => String(event.event_type).startsWith('display_guard_'))
        .every((event) => Number.isInteger(event.client_ts)),
    ).toBe(true)
    expect(state.unexpected).toEqual([])
  })
}

test('native tab focus loss blocks input and preserves the draft and visit until operator confirmation', async ({
  baseURL,
}) => {
  // The normal Playwright context forces every tab to report focus. Its public
  // CDP noDefaults option leaves native focus intact in a disposable profile.
  const profile = await mkdtemp(`${tmpdir()}/a04-display-focus-`)
  const process = spawn(
    chromium.executablePath(),
    [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--window-position=0,0',
      '--window-size=1920,1080',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chromium did not expose CDP')), 10_000)
      let stderr = ''
      process.stderr.on('data', (data) => {
        stderr += String(data)
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
        if (match) {
          clearTimeout(timeout)
          resolve(match[1])
        }
      })
      process.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true })
    const context = browser.contexts()[0]
    try {
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 1080,
        screenWidth: 1920,
        screenHeight: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const state = await setup(page, [questionnaire()])
      await page.goto(`${baseURL}/session`)
      await page.bringToFront()
      await resume(page)
      await page.locator('textarea').fill('Entwurf beim Tabwechsel')
      await expect.poll(() => state.visits.length).toBe(1)
      const visit = state.visits[0].visit_id
      const other = await context.newPage()
      await other.goto('about:blank')
      await other.bringToFront()
      expect(await page.evaluate(() => document.hasFocus())).toBe(false)
      await expect(page.locator('[data-display-guard]')).toHaveAttribute(
        'data-display-guard',
        'blocked',
      )
      await expect(page.getByRole('button', { name: RESUME })).toBeDisabled()
      expect(await page.locator('textarea').evaluate((el) => Boolean(el.closest('[inert]')))).toBe(
        true,
      )
      await other.close()
      await page.bringToFront()
      await expect(page.locator('[data-display-guard]')).toHaveAttribute(
        'data-display-guard',
        'ready',
      )
      expect(state.visits).toHaveLength(1)
      expect(state.responses).toHaveLength(0)
      await resume(page)
      await expect(page.locator('textarea')).toHaveValue('Entwurf beim Tabwechsel')
      expect(state.visits).toHaveLength(1)
      expect(state.visits[0].visit_id).toBe(visit)
      await expect
        .poll(() =>
          state.events.some(
            (event) =>
              event.event_type === 'display_guard_interrupted' &&
              (event.payload as { reasons: string[] }).reasons.includes('window_focus'),
          ),
        )
        .toBe(true)
      expect(state.unexpected).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    process.kill()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a video interruption pauses playback but retains raw gaze and both capture lifecycles', async ({
  page,
}) => {
  const state = await setup(page, [
    {
      kind: 'case_video',
      index: 0,
      completed: false,
      video_id: 7,
      task_description: 'Beobachten Sie den Fall.',
      info_text: '',
      student_task_text: '',
      time_limit_seconds: 600,
    },
  ])
  await page.goto('/session')
  expect(state.screenStarts).toBe(0)
  await resume(page)
  await expect.poll(() => state.screenStarts).toBe(1)
  await expect.poll(() => state.recordings.length).toBe(1)
  const video = page.locator('video')
  await page.locator('[data-aoi="video_play_pause"]').click()
  await expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true)
  await expect.poll(() => state.samples.some((sample) => sample.geometry_ts !== null)).toBe(true)
  const stops = state.commands.filter((command) => command.startsWith('stop_')).length
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  const invalidFrom = Date.now()
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
  await expect
    .poll(
      () =>
        state.samples.filter((sample) => sample.ts > invalidFrom && sample.geometry_ts === null)
          .length,
    )
    .toBeGreaterThan(5)
  expect(state.recordings).toHaveLength(1)
  expect(state.screenStarts).toBe(1)
  expect(state.commands.filter((command) => command.startsWith('stop_')).length).toBe(stops)
  const invalidUntil = Date.now()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await resume(page)
  const verifiedFrom = Date.now()
  await expect
    .poll(() =>
      state.samples.some((sample) => sample.ts > verifiedFrom && sample.geometry_ts !== null),
    )
    .toBe(true)
  const blockedSamples = state.samples.filter(
    (sample) => sample.ts > invalidFrom && sample.ts < invalidUntil,
  )
  expect(blockedSamples.length).toBeGreaterThan(5)
  expect(blockedSamples.every((sample) => sample.geometry_ts === null)).toBe(true)
  expect(state.recordings[0].geometry).toMatchObject({
    display_guard: { profile: 'lab_1080p', verified: true },
  })
  expect(
    state.layouts.some(
      (layout) => (layout.display_guard as { verified?: boolean } | undefined)?.verified === false,
    ),
  ).toBe(true)
  expect(state.samples.find((sample) => sample.geometry_ts === null)).toMatchObject({
    lpd: 3.2,
    rpd: 3.3,
  })
  expect(await video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
  expect(state.unexpected).toEqual([])
})

test('SoSci can open a new tab and returning to measured content requires fresh verification', async ({
  page,
  context,
}) => {
  const sosci: SessionStep = {
    kind: 'sosci',
    index: 1,
    completed: false,
    variant: 'pretest',
    url: 'https://survey.invalid/form',
    id_param: 'participant',
    participant_id: PARTICIPANT,
  }
  const state = await setup(page, [questionnaire(), sosci, questionnaire(2)])
  await context.route('https://survey.invalid/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic survey</h1>' }),
  )
  await page.goto('/session')
  await resume(page)
  await page.locator('textarea').fill('Vor dem externen Fragebogen')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Fragebogen öffnen' }).click()
  const popup = await popupPromise
  await expect(popup.getByRole('heading', { name: 'Synthetic survey' })).toBeVisible()
  expect(popup.url()).toContain(`participant=${PARTICIPANT}`)
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await popup.close()
  await page.bringToFront()
  await page.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' }).click()
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  expect(state.visits).toHaveLength(1)
  await expect(page.locator('textarea')).toHaveCount(0)
  await resume(page)
  await expect(page.getByRole('heading', { name: 'Prüfseite 3', exact: true })).toBeVisible()
  await expect.poll(() => state.visits.length).toBe(2)
  expect(state.unexpected).toEqual([])
})

test('CK deadline saves the blocked draft exactly once and holds the next PCK page until resume', async ({
  page,
}) => {
  const state = await setup(page, [questionnaire(0, true), questionnaire(1)], 5000)
  await page.goto('/session')
  await resume(page)
  await expect.poll(() => state.visits.length).toBe(1)
  await page.locator('textarea').fill('Unvollständiger Ansatz bleibt erhalten')
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  await expect.poll(() => state.finishes.length, { timeout: 10_000 }).toBe(1)
  expect(state.finishes[0]).toMatchObject({
    reason: 'timer_expired',
    visit_id: state.visits[0].visit_id,
    answers: {
      [manifest.ck_tasks[0].question.id]: { explanation: 'Unvollständiger Ansatz bleibt erhalten' },
    },
  })
  await expect(page.locator('textarea')).toHaveCount(0)
  expect(state.visits).toHaveLength(1)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect(page.getByRole('button', { name: RESUME })).toBeEnabled()
  expect(state.visits).toHaveLength(1)
  expect(state.finishes).toHaveLength(1)
  await resume(page)
  await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
  await expect.poll(() => state.visits.length).toBe(2)
  expect(state.finishes).toHaveLength(1)
  expect(state.unexpected).toEqual([])
})

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
const prose = (text: string) =>
  text
    .replace(/^```[^\n]*$/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/^- /gm, '')

async function assertGuardedLayout(page: Page, info: TestInfo, label: string) {
  await expect(page.locator('.display-guard__content')).toHaveCSS('display', 'contents')
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('.pretest-page .panel, .section-intro')!
    const elements = [
      ...panel.querySelectorAll<HTMLElement>(
        'h2, p, li, legend, th, td, pre, button, input, textarea, .matrix__scroll, .matrix__scale-label',
      ),
    ]
    const clipped = elements
      .filter((element) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)
          return false
        const style = getComputedStyle(element)
        return (
          (element.matches('.matrix__scale-label') &&
            element.scrollWidth > element.clientWidth + 1) ||
          (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1) ||
          (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX) &&
            element.scrollWidth > element.clientWidth + 1)
        )
      })
      .map((element) => element.className)
    const outside = elements
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.width &&
          box.height &&
          (box.top < -1 ||
            box.left < -1 ||
            box.bottom > innerHeight + 1 ||
            box.right > innerWidth + 1)
        )
      })
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent?.slice(0, 80),
      }))
    const prose = [
      ...panel.querySelectorAll<HTMLElement>(
        '.lead, .qfield__text, .matrix__prompt, .matrix__table tbody th, .matrix__scale-label, .choice__option, .ranking__label',
      ),
    ]
    const code = [...panel.querySelectorAll<HTMLElement>('pre.code')]
    const controls = [
      ...panel.querySelectorAll<HTMLElement>('button, textarea, .matrix__cell, .choice__option'),
    ]
    return {
      vertical:
        Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight,
      horizontal:
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      scrollY,
      clipped,
      outside,
      proseSize: Math.min(
        ...prose.map((element) => parseFloat(getComputedStyle(element).fontSize)),
      ),
      codeSize: code.length
        ? Math.min(...code.map((element) => parseFloat(getComputedStyle(element).fontSize)))
        : null,
      smallTargets: controls
        .filter((element) => {
          const box = element.getBoundingClientRect()
          return box.height < 24 || box.width < 24
        })
        .map((element) => element.className),
    }
  })
  await info.attach('guard-enabled-layout', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  writeFileSync(info.outputPath(`${label}-metrics.json`), JSON.stringify(metrics, null, 2))
  await page.mouse.move(1910, 1070)
  await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true })
  expect(metrics).toMatchObject({
    vertical: 0,
    horizontal: 0,
    scrollY: 0,
    clipped: [],
    outside: [],
    smallTargets: [],
  })
  expect(metrics.proseSize).toBeGreaterThanOrEqual(15)
  if (metrics.codeSize !== null) expect(metrics.codeSize).toBeGreaterThanOrEqual(14)
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeInViewport({
    ratio: 1,
  })
}

for (const section of ['pck', 'mesp'] as const) {
  const tasks = section === 'pck' ? manifest.pck_pages : manifest.mesp_pages
  for (const [index, task] of tasks.entries()) {
    test(`guard-enabled ${section.toUpperCase()} source task ${task.source_task} preserves wording, order and viewport fit`, async ({
      page,
    }, info) => {
      const step: SessionStep = {
        kind: 'questionnaire',
        index: 0,
        completed: false,
        questionnaire_id: task.source_task,
        placement: 'pre_test',
        title: task.title,
        description: task.description,
        section: section === 'pck' ? 'PCK-Pretest' : 'MESP',
        section_key: section,
        questions: task.questions,
        video_id: null,
        page: (section === 'pck' ? 17 : 20) + index,
        page_count: 25,
      }
      const state = await setup(page, [step])
      await page.goto('/session')
      await resume(page)
      await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await expect(page.getByText('Blickdaten werden empfangen.', { exact: true })).toBeVisible()
      await expect(page.locator('input:checked')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled()
      expect(normalize(await page.locator('[data-aoi="instructions"]').innerText())).toBe(
        normalize(prose(task.description)),
      )
      const ids = await page
        .locator('.questionnaire-controls [data-aoi]')
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute('data-aoi')!)
            .filter((id) => /^question\.[^.]+$/.test(id)),
        )
      expect(ids).toEqual(task.questions.map((question) => `question.${question.id}`))
      for (const question of task.questions) {
        const field = page.locator(`[data-aoi="question.${question.id}"]`)
        const prompt = page.locator(`[data-aoi="question.${question.id}.prompt"]`)
        const text = await prompt.evaluate((element) => {
          const copy = element.cloneNode(true) as HTMLElement
          copy.querySelectorAll('.req').forEach((required) => required.remove())
          return copy.textContent ?? ''
        })
        expect(normalize(text)).toBe(normalize(question.text))
        if (question.matrix_prompt) {
          const text = await page
            .locator(`[data-aoi="matrix.${question.matrix}.prompt"]`)
            .allTextContents()
          expect(normalize(text.join(' '))).toBe(normalize(prose(question.matrix_prompt)))
        }
        const labels = question.options?.map((option) =>
          typeof option === 'string' ? option : option.label,
        )
        if (question.matrix) {
          expect(
            await field
              .getByRole('radio')
              .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
          ).toEqual(
            labels!.map((label, optionIndex) => `${question.text}: ${optionIndex + 1} – ${label}`),
          )
        } else if (question.type === 'multi_select') {
          expect((await field.locator('.choice__option').allTextContents()).map(normalize)).toEqual(
            labels,
          )
        } else if (question.type === 'ranking') {
          expect(await field.locator('.ranking__label').allTextContents()).toEqual(labels)
        }
      }
      const expectedCode = task.description.match(/```java\n([\s\S]*?)\n```/)?.[1].split('\n') ?? []
      const lines = page.locator('.code__line')
      await expect(lines).toHaveCount(expectedCode.length)
      for (const [lineIndex, line] of expectedCode.entries()) {
        expect((await lines.nth(lineIndex).textContent())?.replace(/\n$/, '')).toBe(line)
        await expect(lines.nth(lineIndex)).toHaveAttribute('data-line', String(lineIndex + 1))
      }
      if (section === 'mesp') {
        await expect(page.getByRole('radio')).toHaveCount(30)
        expect(
          await page.locator('.matrix__table thead th:not(:first-child)').allTextContents(),
        ).toEqual(
          task.questions[0].options!.map(
            (option, optionIndex) =>
              `${optionIndex + 1}${typeof option === 'string' ? option : option.label}`,
          ),
        )
      }
      await assertGuardedLayout(page, info, `${section}-${task.source_task}`)
      expect(state.visits).toHaveLength(1)
      expect(state.unexpected).toEqual([])
    })
  }
}

test('guard-enabled MESP introduction preserves the complete instructions and viewport fit', async ({
  page,
}, info) => {
  const state = await setup(page, [
    {
      kind: 'section_intro',
      index: 0,
      completed: false,
      section_key: 'mesp',
      ...manifest.mesp_intro,
      time_limit_seconds: null,
    },
  ])
  await page.goto('/session')
  await resume(page)
  await expect(
    page.getByRole('heading', { name: manifest.mesp_intro.title, exact: true }),
  ).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const displayed = await page.locator('.section-intro p.lead, .section-intro li').allTextContents()
  expect(normalize(displayed.join(' '))).toBe(normalize(prose(manifest.mesp_intro.body)))
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await assertGuardedLayout(page, info, 'mesp-intro')
  expect(state.visits).toHaveLength(0)
  expect(state.unexpected).toEqual([])
})
