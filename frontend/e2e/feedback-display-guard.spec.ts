import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import type { SessionStep } from '../src/api/participant'
import type { Question } from '../src/lib/questionnaire'
import type { NativeViewport } from '../src/lib/nativeViewport'

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

type NativeFixture = {
  x: number
  y: number
  generation: number
  proof?: NativeViewport
  gaze: [number, number]
  sampleId?: string
  sampleDelay?: number
  unavailable?: boolean
  errorCode?: string
  transport?: 'offline' | 'legacy' | 'native'
}
const nativeFixture = (x = 120, y = 90): NativeFixture => ({
  x,
  y,
  generation: 0,
  gaze: [0.5, 0.5],
})

async function setup(
  page: Page,
  steps: SessionStep[],
  ckDuration = 420_000,
  native?: NativeFixture,
) {
  const state = {
    current: 0,
    visits: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    responses: [] as Record<string, unknown>[],
    progress: [] as Record<string, unknown>[],
    finishes: [] as Record<string, unknown>[],
    recordings: [] as Record<string, unknown>[],
    layouts: [] as Record<string, unknown>[],
    samples: [] as {
      ts: number
      geometry_ts: number | null
      lpd?: number
      rpd?: number
      lx: number
      ly: number
      viewport_id?: string | null
      viewport_ts?: number | null
    }[],
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
    if (native?.transport === 'offline') {
      socket.close()
      return
    }
    socket.send(
      JSON.stringify({
        type: 'status',
        connected: true,
        ...(native && native.transport !== 'legacy' ? { native_viewport: true } : {}),
        frequency: 120,
        screen_recording: true,
        stimulus_audio: false,
        screen_width_mm: 345.35,
        screen_height_mm: 194.26,
      }),
    )
    let timer: ReturnType<typeof setInterval> | undefined
    socket.onMessage((message) => {
      const request = JSON.parse(String(message))
      const command = request.type as string
      state.commands.push(command)
      if (native && command === 'viewport_probe') {
        if (native.unavailable) {
          socket.send(
            JSON.stringify({
              type: 'viewport_status',
              request_id: request.request_id,
              tab_id: request.tab_id,
              ok: false,
              error_code: native.errorCode ?? 'not_foreground',
              observed_at: Date.now(),
            }),
          )
          return
        }
        const content = {
          x: native.x,
          y: native.y,
          w: Math.round(request.css.w * request.dpr),
          h: Math.round(request.css.h * request.dpr),
        }
        const previous = native.proof
        if (
          !previous ||
          previous.tab_id !== request.tab_id ||
          previous.dpr !== request.dpr ||
          JSON.stringify(previous.content) !== JSON.stringify(content)
        )
          native.generation++
        native.proof = {
          id: `native-browser-test:${native.generation}`,
          tab_id: request.tab_id,
          display: { x: 0, y: 0, w: 1920, h: 1080 },
          content,
          css: request.css,
          dpr: request.dpr,
        }
        socket.send(
          JSON.stringify({
            type: 'viewport_status',
            request_id: request.request_id,
            tab_id: request.tab_id,
            ok: true,
            observed_at: Date.now(),
            native_viewport: native.proof,
          }),
        )
        return
      }
      if (command === 'start_gaze' && !timer)
        timer = setInterval(
          () =>
            socket.send(
              JSON.stringify({
                type: 'gaze',
                ts: Date.now(),
                lx: native?.gaze[0] ?? 0.5,
                ly: native?.gaze[1] ?? 0.5,
                rx: native?.gaze[0] ?? 0.5,
                ry: native?.gaze[1] ?? 0.5,
                ...(native
                  ? {
                      viewport_id: native.unavailable
                        ? null
                        : (native.sampleId ?? native.proof?.id ?? null),
                      viewport_ts: Date.now() - (native.sampleDelay ?? 0),
                    }
                  : {}),
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
      const response = request.postDataJSON()
      state.responses.push(response)
      if (response.advance) state.current += 1
      return json(progress())
    }
    if (path === '/participant/session/progress') {
      const response = request.postDataJSON()
      state.progress.push(response)
      state.current = response.current_step_index
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
    if (/^\/screen\/recordings\/\d+\/(heartbeat|failed)$/.test(path)) return json({ status: 'ok' })
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
}, info) => {
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
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    try {
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
    } catch (error) {
      writeFileSync(info.outputPath('native-focus-errors.json'), JSON.stringify(errors, null, 2))
      await page.screenshot({ path: info.outputPath('native-focus-failure.png') }).catch(() => {})
      throw error
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
  await expect(
    page.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' }),
  ).toBeDisabled()
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
      await expect.poll(() => state.samples.length).toBeGreaterThan(0)
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
  await expect(
    page.getByRole('heading', { name: manifest.mesp_intro.title, exact: true }),
  ).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const displayed = await page.locator('.section-intro p.lead, .section-intro li').allTextContents()
  expect(normalize(displayed.join(' '))).toBe(normalize(prose(manifest.mesp_intro.body)))
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await assertGuardedLayout(page, info, 'mesp-intro')
  expect(state.visits).toHaveLength(0)
  expect(state.recordings).toHaveLength(0)
  expect(state.screenStarts).toBe(0)
  expect(state.unexpected).toEqual([])
})

async function advanceUnmeasured(page: Page, state: { current: number }, expectedIndex: number) {
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Blickaufzeichnung prüfen' })).toHaveCount(0)
  await expect.poll(() => state.current).toBe(expectedIndex + 1)
}

async function expectUnmeasuredStep(page: Page, step: SessionStep) {
  if (step.kind === 'welcome')
    await expect(page.locator('.id-badge__value')).toHaveText(PARTICIPANT)
  else if (step.kind === 'phase_transition')
    await expect(page.locator('.phase-badge')).toBeVisible()
  else if (step.kind === 'case_intro')
    await expect(page.getByRole('heading', { name: /^Fall \d+/ })).toBeVisible()
  else if (step.kind === 'case_outro')
    await expect(page.getByRole('heading', { name: step.heading, exact: true })).toBeVisible()
  else if (step.kind === 'text_page' || step.kind === 'section_intro')
    await expect(page.getByRole('heading', { name: step.title, exact: true })).toBeVisible()
  else throw new Error(`Unexpected unmeasured test step: ${step.kind}`)
}

test('invalid display settings leave all unmeasured pages navigable and defer the CK visit and deadline', async ({
  page,
}) => {
  const steps: SessionStep[] = [
    { kind: 'welcome', index: 0, completed: false },
    {
      kind: 'text_page',
      index: 1,
      completed: false,
      key: 'pre_intro',
      title: 'Hinweise vor den Aufgaben',
      body: 'Bitte lesen Sie die Hinweise.',
    },
    {
      kind: 'section_intro',
      index: 2,
      completed: false,
      section_key: 'ck_tasks',
      title: 'Fachwissen',
      body: 'Bitte lesen Sie die Hinweise zum Fachwissen.',
      time_limit_seconds: 420,
    },
    {
      kind: 'section_intro',
      index: 3,
      completed: false,
      section_key: 'pck',
      title: 'Fachdidaktisches Wissen',
      body: 'Bitte lesen Sie die Hinweise zu den Lernsituationen.',
      time_limit_seconds: null,
    },
    {
      kind: 'section_intro',
      index: 4,
      completed: false,
      section_key: 'mesp',
      ...manifest.mesp_intro,
      time_limit_seconds: null,
    },
    {
      kind: 'phase_transition',
      index: 5,
      completed: false,
      phase_type: 'training',
      phase_number: 2,
    },
    {
      kind: 'case_intro',
      index: 6,
      completed: false,
      phase_type: 'training',
      video_id: 7,
      title: '',
      body: '',
    },
    {
      kind: 'case_outro',
      index: 7,
      completed: false,
      phase_type: 'training',
      video_id: 7,
      questionnaire_id: null,
      title: 'Fallabschluss',
      heading: 'Fallabschluss ohne Fragen',
      section: 'Fallabschluss',
      instruction: '',
      questions: [],
    },
    questionnaire(8, true),
  ]
  const state = await setup(page, steps)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/session')
  for (const step of steps.slice(0, -1)) {
    await expectUnmeasuredStep(page, step)
    await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
    expect(state.visits).toHaveLength(0)
    expect(state.recordings).toHaveLength(0)
    expect(state.screenStarts).toBe(0)
    expect(state.timing).toBeNull()
    await advanceUnmeasured(page, state, step.index)
  }
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  await expect(page.getByRole('button', { name: RESUME })).toBeDisabled()
  await expect(page.locator('textarea')).toHaveCount(0)
  expect(state.visits).toHaveLength(0)
  expect(state.recordings).toHaveLength(0)
  expect(state.timing).toBeNull()
  expect(state.progress).toHaveLength(8)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect(page.getByRole('button', { name: RESUME })).toBeEnabled()
  expect(state.visits).toHaveLength(0)
  expect(state.timing).toBeNull()
  await resume(page)
  await expect.poll(() => state.visits.length).toBe(1)
  await expect(page.locator('textarea')).toBeVisible()
  expect(state.timing).toMatchObject({
    section_key: 'ck_tasks',
    duration_seconds: 420,
    finished: false,
  })
  expect(state.unexpected).toEqual([])
})

test('a questionnaire-backed outro retains its existing guard and capture scope even with no questions', async ({
  page,
}) => {
  const state = await setup(page, [
    {
      kind: 'case_outro',
      index: 0,
      completed: false,
      phase_type: 'training',
      video_id: 7,
      questionnaire_id: 99,
      title: 'Leerer Fragebogen',
      section: 'Fallabschluss',
      instruction: '',
      questions: [],
    },
  ])
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/session')
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  await expect(page.getByRole('button', { name: RESUME })).toBeDisabled()
  expect(state.recordings).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await resume(page)
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  await expect.poll(() => state.recordings.length).toBe(1)
  expect(state.recordings[0]).toMatchObject({ step_kind: 'case_outro', questionnaire_id: 99 })
  expect(state.screenStarts).toBe(0)
  expect(state.unexpected).toEqual([])
})

for (const disturbed of [false, true]) {
  test(`ordinary instructions ${disturbed ? 'silently revoke changed display settings' : 'retain valid verification'} before the next measured page`, async ({
    page,
  }) => {
    const steps: SessionStep[] = [
      questionnaire(),
      {
        kind: 'text_page',
        index: 1,
        completed: false,
        key: 'pre_intro',
        title: 'Hinweise zwischen Aufgaben',
        body: 'Bitte lesen Sie die Hinweise.',
      },
      {
        kind: 'section_intro',
        index: 2,
        completed: false,
        section_key: 'pck',
        title: 'Weitere Aufgaben',
        body: 'Bitte bearbeiten Sie die nächste Aufgabe.',
        time_limit_seconds: null,
      },
      {
        kind: 'case_intro',
        index: 3,
        completed: false,
        phase_type: 'training',
        video_id: 7,
        title: '',
        body: '',
      },
      questionnaire(4),
    ]
    const state = await setup(page, steps)
    await page.goto('/session')
    await resume(page)
    await expect.poll(() => state.recordings.length).toBe(1)
    await page.locator('textarea').fill('Antwort vor den Hinweisen')
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Hinweise zwischen Aufgaben', exact: true }),
    ).toBeVisible()
    if (disturbed) {
      await page.setViewportSize({ width: 1600, height: 900 })
      await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
      await page.setViewportSize({ width: 1920, height: 1080 })
    }
    for (const step of steps.slice(1, -1)) {
      await expectUnmeasuredStep(page, step)
      await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeVisible()
      await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
      expect(state.visits).toHaveLength(1)
      expect(state.recordings).toHaveLength(1)
      await advanceUnmeasured(page, state, step.index)
    }
    if (disturbed) {
      await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
      await expect(page.locator('textarea')).toHaveCount(0)
      expect(state.visits).toHaveLength(1)
      await resume(page)
    }
    await expect(page.getByRole('heading', { name: 'Prüfseite 5', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
    await expect.poll(() => state.visits.length).toBe(2)
    await expect
      .poll(
        () => state.events.filter((event) => event.event_type === 'display_guard_resumed').length,
      )
      .toBe(disturbed ? 2 : 1)
    expect(state.unexpected).toEqual([])
  })
}

const CONTINUE_UNVERIFIED = 'Mit aktueller Anzeige fortfahren'

async function retainLabScreen(page: Page) {
  // Playwright's setViewportSize also changes screen dimensions. Keep the
  // physical monitor at 1080p while exercising smaller browser windows.
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({ width: 1920, height: 1080 }))
      Object.defineProperty(window.screen, key, { configurable: true, get: () => value })
  })
}

async function continueUnverified(page: Page) {
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  const button = page.getByRole('button', { name: CONTINUE_UNVERIFIED, exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
}

for (const reportedDisplay of ['windowed', 'fullscreen with negative origin', 'scaled'] as const) {
  test(`unverified continuation works ${reportedDisplay}, preserves drafts and never certifies gaze`, async ({
    page,
  }, info) => {
    const state = await setup(page, [questionnaire(), questionnaire(1)])
    if (reportedDisplay === 'fullscreen with negative origin') {
      // A fullscreen viewport does not establish the outer-window origin that
      // Windows/Edge reports. Do not turn these uncertain metrics into verified gaze.
      await page.addInitScript(() => {
        for (const [key, value] of Object.entries({ screenX: -8, screenY: -8 }))
          Object.defineProperty(window, key, { configurable: true, get: () => value })
      })
    } else {
      await page.setViewportSize(
        reportedDisplay === 'scaled' ? { width: 1536, height: 864 } : { width: 1600, height: 900 },
      )
      if (reportedDisplay === 'scaled')
        await page.addInitScript(() => {
          Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 1.25 })
        })
    }
    await retainLabScreen(page)
    await page.goto('/session')
    if (reportedDisplay === 'fullscreen with negative origin') {
      await page.getByRole('button', { name: 'Vollbild öffnen' }).click()
      expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
    }
    await expect(page.getByRole('button', { name: RESUME })).toBeDisabled()
    expect(state.visits).toHaveLength(0)
    expect(state.recordings).toHaveLength(0)
    await page.screenshot({ path: info.outputPath('display-recovery-offered.png') })
    await continueUnverified(page)
    await expect.poll(() => state.visits.length).toBe(1)
    await page.locator('textarea').fill('Der Entwurf bleibt beim Ändern der Anzeige erhalten.')
    const visit = state.visits[0].visit_id
    await expect.poll(() => state.recordings.length).toBe(1)
    expect(state.recordings[0].geometry).toMatchObject({
      display_guard: { profile: 'lab_1080p', verified: false },
    })
    await expect.poll(() => state.samples.length).toBeGreaterThan(5)
    expect(state.samples.every((sample) => sample.geometry_ts === null)).toBe(true)
    expect(state.samples[0]).toMatchObject({ lpd: 3.2, rpd: 3.3 })

    if (reportedDisplay === 'fullscreen with negative origin') {
      await page.evaluate(() => document.exitFullscreen())
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false)
    }
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
    await expect(page.locator('textarea')).toHaveValue(
      'Der Entwurf bleibt beim Ändern der Anzeige erhalten.',
    )
    expect(state.visits).toHaveLength(1)
    expect(state.visits[0].visit_id).toBe(visit)
    expect(await page.locator('textarea').evaluate((el) => Boolean(el.closest('[inert]')))).toBe(
      false,
    )
    await page.screenshot({ path: info.outputPath('windowed-task-after-recovery.png') })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
    await expect.poll(() => state.visits.length).toBe(2)
    expect(state.responses[0]).toMatchObject({
      answers: { answer_0: 'Der Entwurf bleibt beim Ändern der Anzeige erhalten.' },
    })
    expect(state.events.filter((event) => event.event_type === 'display_guard_resumed')).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('unverified continuation keeps the CK deadline and saves its draft once before PCK', async ({
  page,
}, info) => {
  const state = await setup(page, [questionnaire(0, true), questionnaire(1)], 5000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await retainLabScreen(page)
  await page.goto('/session')
  expect(state.timing).toBeNull()
  await continueUnverified(page)
  await expect.poll(() => state.visits.length).toBe(1)
  const deadline = state.timing?.deadline_ms
  await page.locator('textarea').fill('Teilantwort im Fenstermodus')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  expect(state.timing?.deadline_ms).toBe(deadline)
  await expect.poll(() => state.finishes.length, { timeout: 10_000 }).toBe(1)
  expect(state.finishes[0]).toMatchObject({
    reason: 'timer_expired',
    visit_id: state.visits[0].visit_id,
    answers: {
      [manifest.ck_tasks[0].question.id]: { explanation: 'Teilantwort im Fenstermodus' },
    },
  })
  await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await expect.poll(() => state.visits.length).toBe(2)
  await page.locator('textarea').fill('PCK bleibt bedienbar')
  expect(state.finishes).toHaveLength(1)
  expect(state.events.filter((event) => event.event_type === 'display_guard_resumed')).toEqual([])
  expect(state.unexpected).toEqual([])
  await page.screenshot({ path: info.outputPath('pck-after-windowed-ck-expiry.png') })
})

test('unverified continuation permits the SoSci popup and return without another display lock', async ({
  page,
  context,
}, info) => {
  const state = await setup(page, [
    questionnaire(),
    {
      kind: 'sosci',
      index: 1,
      completed: false,
      variant: 'pretest',
      url: 'https://survey.invalid/form',
      id_param: 'participant',
      participant_id: PARTICIPANT,
    },
    questionnaire(2),
  ])
  await context.route('https://survey.invalid/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic survey</h1>' }),
  )
  await page.setViewportSize({ width: 1600, height: 900 })
  await retainLabScreen(page)
  await page.goto('/session')
  await continueUnverified(page)
  await page.locator('textarea').fill('Antwort vor SoSci')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  const done = page.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' })
  await expect(done).toBeDisabled()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Fragebogen öffnen' }).click()
  const popup = await popupPromise
  await expect(popup.getByRole('heading', { name: 'Synthetic survey' })).toBeVisible()
  expect(popup.url()).toContain(`participant=${PARTICIPANT}`)
  await popup.close()
  await page.bringToFront()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(done).toBeEnabled()
  await done.click()
  await expect(page.getByRole('heading', { name: 'Prüfseite 3', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await expect.poll(() => state.visits.length).toBe(2)
  await page.locator('textarea').fill('Antwort nach SoSci')
  expect(state.events.filter((event) => event.event_type === 'display_guard_resumed')).toEqual([])
  expect(state.unexpected).toEqual([])
  await page.screenshot({ path: info.outputPath('windowed-return-from-sosci.png') })
})

test('unverified continuation allows video playback and resize while retaining raw gaze as unverified', async ({
  page,
}, info) => {
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
  await page.setViewportSize({ width: 1600, height: 900 })
  await retainLabScreen(page)
  await page.goto('/session')
  await continueUnverified(page)
  await expect.poll(() => state.recordings.length).toBe(1)
  await expect.poll(() => state.screenStarts).toBe(1)
  const video = page.locator('video')
  // Keep the short fixture playing while resize and upload assertions run.
  await video.evaluate((el) => {
    ;(el as HTMLVideoElement).loop = true
  })
  await page.locator('[data-aoi="video_play_pause"]').click()
  await expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await expect.poll(() => state.samples.length).toBeGreaterThan(5)
  expect(await video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(false)
  expect(state.samples.every((sample) => sample.geometry_ts === null)).toBe(true)
  expect(state.samples[0]).toMatchObject({ lpd: 3.2, rpd: 3.3 })
  expect(state.recordings[0].geometry).toMatchObject({
    display_guard: { profile: 'lab_1080p', verified: false },
  })
  expect(
    state.layouts.every(
      (layout) => (layout.display_guard as { verified?: boolean } | undefined)?.verified === false,
    ),
  ).toBe(true)
  expect(state.recordings).toHaveLength(1)
  expect(state.screenStarts).toBe(1)
  expect(state.events.filter((event) => event.event_type === 'display_guard_resumed')).toEqual([])
  expect(state.unexpected).toEqual([])
  await page.screenshot({ path: info.outputPath('windowed-video-playing.png') })
})

test('unverified continuation recovers an interrupted draft and does not recertify restored dimensions', async ({
  page,
}, info) => {
  const state = await setup(page, [questionnaire(), questionnaire(1)])
  await retainLabScreen(page)
  await page.goto('/session')
  await resume(page)
  await page.locator('textarea').fill('Bereits begonnene Antwort bleibt bestehen')
  await expect.poll(() => state.visits.length).toBe(1)
  const visit = state.visits[0].visit_id
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  await continueUnverified(page)
  await expect(page.locator('textarea')).toHaveValue('Bereits begonnene Antwort bleibt bestehen')
  expect(state.visits).toHaveLength(1)
  expect(state.visits[0].visit_id).toBe(visit)
  const continuedAt = Date.now()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await expect
    .poll(() => state.samples.filter((sample) => sample.ts > continuedAt).length)
    .toBeGreaterThan(5)
  expect(
    state.samples
      .filter((sample) => sample.ts > continuedAt)
      .every((sample) => sample.geometry_ts === null),
  ).toBe(true)
  expect(state.layouts.at(-1)).toMatchObject({
    display_guard: { profile: 'lab_1080p', verified: false },
  })
  expect(state.events.filter((event) => event.event_type === 'display_guard_resumed')).toHaveLength(
    1,
  )
  await page.screenshot({ path: info.outputPath('interrupted-draft-recovered.png') })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
  expect(state.responses[0]).toMatchObject({
    answers: { answer_0: 'Bereits begonnene Antwort bleibt bestehen' },
  })
  expect(state.unexpected).toEqual([])
})

for (const mode of ['windowed', 'fullscreen', 'zoomed'] as const) {
  test(`native viewport maps received gaze against actual DOM AOIs in ${mode} mode`, async ({
    page,
  }, info) => {
    const native = nativeFixture(mode === 'fullscreen' ? 0 : 120, mode === 'fullscreen' ? 0 : 90)
    const dpr = mode === 'zoomed' ? 1.25 : 1
    await page.addInitScript((scale) => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => scale })
      Object.defineProperty(window.screen, 'width', { configurable: true, get: () => 1920 })
      Object.defineProperty(window.screen, 'height', { configurable: true, get: () => 1080 })
    }, dpr)
    await page.setViewportSize(
      mode === 'fullscreen' ? { width: 1920, height: 1080 } : { width: 1152, height: 640 },
    )
    const state = await setup(page, [questionnaire(), questionnaire(1)], 420_000, native)
    await page.goto('/session')
    if (mode === 'fullscreen') await page.getByRole('button', { name: 'Vollbild öffnen' }).click()
    await expect(
      page.getByText('Die Position der Studienseite wurde gemessen.', { exact: false }),
    ).toBeVisible()
    await resume(page)
    await expect.poll(() => state.recordings.length).toBe(1)
    await page.locator('textarea').fill('Erfasste Antwort mit gemessener Fensterposition')
    const target = await page.locator('textarea').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        aoi: el.closest('[data-aoi]')?.getAttribute('data-aoi'),
      }
    })
    expect(target.aoi).toBeTruthy()
    const proof = native.proof!
    native.gaze = [
      (proof.content.x + target.x * proof.dpr) / proof.display.w,
      (proof.content.y + target.y * proof.dpr) / proof.display.h,
    ]
    const from = Date.now()
    await expect
      .poll(
        () =>
          state.samples.filter((sample) => sample.ts > from && sample.geometry_ts !== null).length,
      )
      .toBeGreaterThan(5)
    const rows = state.samples.filter((sample) => sample.ts > from && sample.geometry_ts !== null)
    expect(
      rows.every(
        (sample) =>
          sample.viewport_id === proof.id && Math.abs(sample.viewport_ts! - sample.ts) <= 50,
      ),
    ).toBe(true)
    const layouts = [state.recordings[0].geometry, ...state.layouts] as Array<
      Record<string, unknown>
    >
    for (const row of rows) {
      const geometry = layouts.find((layout) => layout.ts === row.geometry_ts)!
      expect(geometry).toMatchObject({
        display_guard: { profile: 'native_viewport_v1', verified: true },
        native_viewport: proof,
      })
      const x = (row.lx * proof.display.w - proof.content.x) / proof.dpr
      const y = (row.ly * proof.display.h - proof.content.y) / proof.dpr
      const areas = geometry.aois as Array<{
        id: string
        x: number
        y: number
        w: number
        h: number
      }>
      const area = areas.find((aoi) => aoi.id === target.aoi)!
      expect(area).toBeTruthy()
      expect(x).toBeGreaterThanOrEqual(area.x)
      expect(x).toBeLessThan(area.x + area.w)
      expect(y).toBeGreaterThanOrEqual(area.y)
      expect(y).toBeLessThan(area.y + area.h)
    }
    expect(state.layouts.length).toBeLessThan(20) // Heartbeat proof must not exhaust the snapshot limit.
    expect(
      state.events.some((event) => event.event_type === 'display_guard_continued_unverified'),
    ).toBe(false)
    writeFileSync(
      info.outputPath(`native-${mode}-roundtrip.json`),
      JSON.stringify(
        { layouts, samples: rows, expected_aoi: target.aoi, events: state.events },
        null,
        2,
      ),
    )
    await page.screenshot({ path: info.outputPath(`native-${mode}-mapping.png`) })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
    expect(state.responses[0]).toMatchObject({
      answers: { answer_0: 'Erfasste Antwort mit gemessener Fensterposition' },
    })
    expect(state.unexpected).toEqual([])
  })
}

test('native viewport remeasures movement and resize automatically without losing a draft', async ({
  page,
}, info) => {
  const native = nativeFixture()
  await page.setViewportSize({ width: 1152, height: 640 })
  const state = await setup(page, [questionnaire()], 420_000, native)
  await page.goto('/session')
  await resume(page)
  await page.locator('textarea').fill('Entwurf bei Fensteränderung')
  await expect.poll(() => state.visits.length).toBe(1)
  const visit = state.visits[0].visit_id
  const firstId = native.proof!.id
  native.x = 240
  native.y = 135
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect.poll(() => native.proof?.id).not.toBe(firstId)
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden({ timeout: 6000 })
  await expect(page.locator('textarea')).toHaveValue('Entwurf bei Fensteränderung')
  expect(state.visits).toHaveLength(1)
  expect(state.visits[0].visit_id).toBe(visit)
  const now = Date.now()
  await expect
    .poll(
      () =>
        state.samples.filter(
          (row) => row.ts > now && row.geometry_ts !== null && row.viewport_id === native.proof!.id,
        ).length,
    )
    .toBeGreaterThan(5)
  expect(
    state.events.filter(
      (event) =>
        event.event_type === 'display_guard_resumed' &&
        (event.payload as { profile?: string }).profile === 'native_viewport_v1',
    ).length,
  ).toBeGreaterThanOrEqual(2)
  expect(
    state.events.some((event) => event.event_type === 'display_guard_continued_unverified'),
  ).toBe(false)
  await page.screenshot({ path: info.outputPath('native-resized-draft.png') })
})

test('native viewport excludes only samples with a stale or different physical geometry proof', async ({
  page,
}) => {
  const native = nativeFixture()
  await page.setViewportSize({ width: 1152, height: 640 })
  const state = await setup(page, [questionnaire()], 420_000, native)
  await page.goto('/session')
  await resume(page)
  await expect
    .poll(() => state.samples.filter((row) => row.geometry_ts !== null).length)
    .toBeGreaterThan(5)
  native.sampleId = 'queued-from-previous-window'
  const mismatchedAt = Date.now()
  await expect
    .poll(
      () =>
        state.samples.filter((row) => row.ts > mismatchedAt && row.viewport_id === native.sampleId)
          .length,
    )
    .toBeGreaterThan(5)
  expect(
    state.samples
      .filter((row) => row.ts > mismatchedAt && row.viewport_id === native.sampleId)
      .every((row) => row.geometry_ts === null),
  ).toBe(true)
  native.sampleId = undefined
  native.sampleDelay = 200
  const staleAt = Date.now()
  await expect
    .poll(
      () =>
        state.samples.filter((row) => row.ts > staleAt && row.viewport_id === native.proof!.id)
          .length,
    )
    .toBeGreaterThan(5)
  expect(
    state.samples.filter((row) => row.ts > staleAt).every((row) => row.geometry_ts === null),
  ).toBe(true)
  native.sampleDelay = 0
  const recoveredAt = Date.now()
  await expect
    .poll(
      () => state.samples.filter((row) => row.ts > recoveredAt && row.geometry_ts !== null).length,
    )
    .toBeGreaterThan(5)
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
})

test('native windowed CK deadline and SoSci return retain verified mapping', async ({
  page,
  context,
}) => {
  const native = nativeFixture()
  await page.setViewportSize({ width: 1152, height: 640 })
  const state = await setup(
    page,
    [
      questionnaire(0, true),
      {
        kind: 'sosci',
        index: 1,
        completed: false,
        variant: 'pretest',
        url: 'https://survey.invalid/form',
        id_param: 'participant',
        participant_id: PARTICIPANT,
      },
      questionnaire(2),
    ],
    5000,
    native,
  )
  await context.route('https://survey.invalid/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic survey</h1>' }),
  )
  await page.goto('/session')
  await resume(page)
  await page.locator('textarea').fill('Native CK-Teilantwort')
  const deadline = state.timing?.deadline_ms
  await page.setViewportSize({ width: 1100, height: 680 })
  await expect.poll(() => state.finishes.length, { timeout: 10000 }).toBe(1)
  expect(state.timing?.deadline_ms).toBe(deadline)
  expect(state.finishes[0]).toMatchObject({
    reason: 'timer_expired',
    answers: { [manifest.ck_tasks[0].question.id]: { explanation: 'Native CK-Teilantwort' } },
  })
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Fragebogen öffnen' }).click()
  const popup = await popupPromise
  await expect(popup.getByRole('heading', { name: 'Synthetic survey' })).toBeVisible()
  await popup.close()
  await page.bringToFront()
  await page.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' }).click()
  await expect(page.getByRole('heading', { name: 'Prüfseite 3', exact: true })).toBeVisible({
    timeout: 6000,
  })
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  const now = Date.now()
  await expect
    .poll(() => state.samples.filter((row) => row.ts > now && row.geometry_ts !== null).length)
    .toBeGreaterThan(5)
  expect(state.finishes).toHaveLength(1)
  expect(state.unexpected).toEqual([])
})

const RECONNECT = 'Bridge erneut verbinden'

async function mockLoopbackPermission(page: Page, initial: PermissionState) {
  await page.addInitScript((permission) => {
    let current = permission
    const status = new EventTarget()
    Object.defineProperty(status, 'state', { get: () => current })
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => status },
    })
    ;(
      window as unknown as { setBridgePermission: (state: PermissionState) => void }
    ).setBridgePermission = (value) => {
      current = value
      status.dispatchEvent(new Event('change'))
    }
  }, initial)
}

test('bridge recovery explains a denied permission and waits for the researcher before connecting', async ({
  page,
}) => {
  const native = nativeFixture()
  native.transport = 'offline'
  await mockLoopbackPermission(page, 'denied')
  await page.setViewportSize({ width: 1152, height: 640 })
  const state = await setup(page, [questionnaire()], 420_000, native)
  let releasePrompt!: () => void
  const permissionPrompt = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  let prompted = false
  await page.route('http://127.0.0.1:8766/', async (route) => {
    prompted = true
    await permissionPrompt
    await route.fulfill({ status: 426, body: 'WebSocket upgrade required' })
  })
  await page.goto('/session')
  await expect(
    page.getByText('Die Windows-Bridge auf diesem PC ist nicht erreichbar.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/Edge blockiert den Zugriff/).first()).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Aktuelle Windows-Bridge herunterladen' }),
  ).toHaveAttribute('href', '/downloads/A04Bridge-native-20261117.zip')
  await expect
    .poll(() =>
      state.events.some(
        (event) =>
          event.event_type === 'display_connection_status' &&
          (event.payload as { loopback_permission?: string }).loopback_permission === 'denied',
      ),
    )
    .toBe(true)
  native.transport = 'native'
  await page.getByRole('button', { name: RECONNECT, exact: true }).click()
  await expect.poll(() => prompted).toBe(true)
  await expect(page.getByRole('button', { name: RECONNECT, exact: true })).toBeDisabled()
  // A human may need longer than the old five-second handshake timeout.
  await page.waitForTimeout(6_000)
  expect(state.visits).toHaveLength(0)
  expect(state.recordings).toHaveLength(0)
  expect(state.commands).toHaveLength(0)
  await page.evaluate(() =>
    (
      window as unknown as { setBridgePermission: (state: PermissionState) => void }
    ).setBridgePermission('granted'),
  )
  releasePrompt()
  await resume(page)
  await expect(page.locator('textarea')).toBeVisible()
  await expect
    .poll(() => state.samples.filter((sample) => sample.geometry_ts !== null).length)
    .toBeGreaterThan(5)
  expect(
    state.events.some((event) => event.event_type === 'display_guard_continued_unverified'),
  ).toBe(false)
})

test('bridge recovery upgrades an old bridge without bypassing native gaze verification', async ({
  page,
}) => {
  const native = nativeFixture()
  native.transport = 'legacy'
  await page.setViewportSize({ width: 1152, height: 640 })
  const state = await setup(page, [questionnaire()], 420_000, native)
  await page.route('http://127.0.0.1:8766/', (route) =>
    route.fulfill({ status: 426, body: 'Upgrade required' }),
  )
  await page.goto('/session')
  await expect(page.getByLabel('Verbindung zur Windows-Bridge')).toContainText(
    /noch keine Messung im Fenstermodus/,
  )
  await expect(page.getByRole('button', { name: RESUME, exact: true })).toBeDisabled()
  native.transport = 'native'
  await page.getByRole('button', { name: RECONNECT, exact: true }).click()
  await resume(page)
  await expect
    .poll(() => state.samples.filter((sample) => sample.geometry_ts !== null).length)
    .toBeGreaterThan(5)
  expect(
    state.events.some((event) => event.event_type === 'display_guard_continued_unverified'),
  ).toBe(false)
})

test('bridge recovery shows a native measurement failure and retains the confirmed draft', async ({
  page,
}) => {
  const native = nativeFixture()
  await page.setViewportSize({ width: 1152, height: 640 })
  const state = await setup(page, [questionnaire()], 420_000, native)
  await page.goto('/session')
  await resume(page)
  await page.locator('textarea').fill('Diese Antwort muss erhalten bleiben.')
  native.unavailable = true
  native.errorCode = 'multiple_displays'
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  await expect(page.getByLabel('Verbindung zur Windows-Bridge')).toContainText(/Bildschirm/)
  await page.getByText('Technischer Status', { exact: false }).click()
  await expect(page.getByLabel('Technische Diagnose ohne Teilnehmerdaten')).toContainText(
    'multiple_displays',
  )
  await expect(page.getByLabel('Technische Diagnose ohne Teilnehmerdaten')).toContainText(
    '2026-11-18.1',
  )
  native.unavailable = false
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await expect(page.locator('textarea')).toHaveValue('Diese Antwort muss erhalten bleiben.')
  expect(state.recordings).toHaveLength(1)
})

test('bridge reconnect permission wait preserves the CK deadline and its partial answer', async ({
  page,
}) => {
  const native = nativeFixture()
  await page.setViewportSize({ width: 1152, height: 640 })
  const state = await setup(page, [questionnaire(0, true), questionnaire(1)], 8_000, native)
  let releasePrompt!: () => void
  const prompt = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  await page.route('http://127.0.0.1:8766/', async (route) => {
    await prompt
    await route.fulfill({ status: 426, body: 'Upgrade required' })
  })
  await page.goto('/session')
  await resume(page)
  await page.locator('textarea').fill('Antwort vor der erneuten Verbindung')
  native.unavailable = true
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
  await page.getByRole('button', { name: RECONNECT, exact: true }).click()
  await expect.poll(() => state.finishes.length, { timeout: 12_000 }).toBe(1)
  expect(JSON.stringify(state.finishes[0])).toContain('Antwort vor der erneuten Verbindung')
  native.unavailable = false
  releasePrompt()
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
  expect(state.finishes).toHaveLength(1)
})

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`bridge recovery controls fit at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, info) => {
    const native = nativeFixture()
    native.transport = 'offline'
    await mockLoopbackPermission(page, 'denied')
    await page.setViewportSize(viewport)
    await setup(page, [questionnaire()], 420_000, native)
    await page.goto('/session')
    await expect(page.getByText(/Edge blockiert den Zugriff/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: RECONNECT, exact: true })).toBeInViewport()
    await expect(
      page.getByRole('link', { name: 'Aktuelle Windows-Bridge herunterladen' }),
    ).toBeInViewport()
    await page.screenshot({ path: info.outputPath(`bridge-recovery-${viewport.width}.png`) })
    await page.getByText('Technischer Status', { exact: false }).click()
    await expect(page.getByLabel('Technische Diagnose ohne Teilnehmerdaten')).toContainText(
      '2026-11-18.1',
    )
  })
}

test('a scrollbar change reported by the visual viewport does not reopen the dialog', async ({
  page,
}) => {
  const state = await setup(page, [questionnaire()])
  await page.goto('/session')
  await resume(page)
  await page.locator('textarea').fill('Entwurf')
  const confirmed = Date.now()
  await expect
    .poll(
      () =>
        state.samples.filter((sample) => sample.ts > confirmed && sample.geometry_ts !== null)
          .length,
    )
    .toBeGreaterThan(5)
  // Headless Chromium hides scrollbars; Windows announces one exactly like this.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.visualViewport?.dispatchEvent(new Event('resize')))
    await page.waitForTimeout(200)
    await expect(page.getByRole('dialog', { name: DIALOG })).toBeHidden()
  }
  expect(
    state.events.filter((event) => event.event_type === 'display_guard_interrupted'),
  ).toHaveLength(1)
  expect(
    state.samples.filter((sample) => sample.ts > confirmed + 200 && sample.geometry_ts === null),
  ).toEqual([])
  expect(state.unexpected).toEqual([])
})

// ---------------------------------------------------------------------------
// Observing guard (@observe): the lab default. The display is checked, shown
// and recorded; nothing ever stops the participant. Run through
// playwright.display-check.config.ts, which builds without the blocking flag.
// ---------------------------------------------------------------------------
async function expectNoPersistentDisplayStatus(page: Page) {
  await expect(
    page.locator(
      '[data-aoi="gaze_health"], [data-aoi="display_check_notice"], .display-check__section',
    ),
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Einstellungen anzeigen' })).toHaveCount(0)
}

async function expectOnlyVerticalDifferences(page: Page) {
  const rows = page.locator('.display-check__section [data-check]')
  const values = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return {
        status: element.getAttribute('data-status'),
        x: box.x,
        top: box.top,
        bottom: box.bottom,
      }
    }),
  )
  expect(values.length).toBeGreaterThan(0)
  for (const [index, value] of values.entries()) {
    expect(['warn', 'fail', 'info']).toContain(value.status)
    if (index > 0) {
      expect(value.top).toBeGreaterThanOrEqual(values[index - 1].bottom)
      expect(value.x).toBeCloseTo(values[index - 1].x, 0)
    }
  }
  await expect(page.locator('.display-check__section table')).toHaveCount(0)
  for (const row of await rows.all()) {
    const current = await row.locator('.display-check__current').boundingBox()
    const expected = await row.locator('.display-check__expected').boundingBox()
    expect(current).not.toBeNull()
    expect(expected).not.toBeNull()
    expect(expected!.y).toBeGreaterThanOrEqual(current!.y + current!.height)
    expect(expected!.x).toBeCloseTo(current!.x, 0)
  }
}
type ObservedState = Awaited<ReturnType<typeof setup>>
const guardEvents = (state: ObservedState) =>
  state.events
    .filter((event) => String(event.event_type).startsWith('display_guard_'))
    .map((event) => String(event.event_type).replace('display_guard_', ''))
const mappedSince = (state: ObservedState, from: number) =>
  state.samples.filter((sample) => sample.ts > from && sample.geometry_ts !== null)
const unmappedSince = (state: ObservedState, from: number) =>
  state.samples.filter((sample) => sample.ts > from && sample.geometry_ts === null)
const snapshots = (state: ObservedState) =>
  [...state.recordings.map((recording) => recording.geometry), ...state.layouts] as Array<{
    ts: number
    display_guard?: { profile: string; verified: boolean }
  }>
/** What the backend receives, for replaying through its own AOI mapping. */
function saveRoundtrip(info: TestInfo, name: string, state: ObservedState, extra = {}) {
  writeFileSync(
    info.outputPath(`${name}.json`),
    JSON.stringify(
      { layouts: snapshots(state), samples: state.samples, events: state.events, ...extra },
      null,
      2,
    ),
  )
}
const caseVideo: SessionStep = {
  kind: 'case_video',
  index: 0,
  completed: false,
  video_id: 7,
  task_description: 'Beobachten Sie den Fall.',
  info_text: '',
  student_task_text: '',
  time_limit_seconds: 600,
}

test('@observe a correct display asks nothing: the page starts at once and gaze is mapped', async ({
  page,
}, info) => {
  const state = await setup(page, [questionnaire(), questionnaire(1)])
  const opened = Date.now()
  await page.goto('/session')
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => state.visits.length).toBe(1)
  await page.locator('textarea').fill('Sofort nutzbar')
  await expect.poll(() => mappedSince(state, opened).length).toBeGreaterThan(5)
  await expectNoPersistentDisplayStatus(page)
  expect(snapshots(state).some((layout) => layout.display_guard?.verified === true)).toBe(true)
  expect(snapshots(state).every((layout) => layout.display_guard?.profile === 'lab_1080p')).toBe(
    true,
  )
  const boundaries = state.events.filter((event) =>
    String(event.event_type).startsWith('display_guard_'),
  )
  expect(guardEvents(state)).toEqual(['interrupted', 'resumed'])
  // An interval whose ends share a timestamp could never be closed by the backend.
  expect(boundaries[1].client_ts as number).toBeGreaterThan(boundaries[0].client_ts as number)
  // Mapped samples reference a verified layout taken at or before them. The
  // layout is re-measured on the frame after verification, so the few samples
  // in between still point at the earlier one; the backend leaves those unmapped.
  const verifiedAt = boundaries[1].client_ts as number
  await expect.poll(() => mappedSince(state, verifiedAt + 100).length).toBeGreaterThan(5)
  for (const sample of mappedSince(state, verifiedAt + 100)) {
    const layout = snapshots(state).find((entry) => entry.ts === sample.geometry_ts)
    expect(layout?.display_guard?.verified).toBe(true)
    expect(sample.geometry_ts!).toBeLessThanOrEqual(sample.ts)
  }
  expect(mappedSince(state, opened).every((sample) => sample.ts >= verifiedAt)).toBe(true)
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Prüfseite 2', exact: true })).toBeVisible()
  await expectNoPersistentDisplayStatus(page)
  const second = Date.now()
  await expect.poll(() => mappedSince(state, second).length).toBeGreaterThan(5)
  // The next measured page keeps the verification: no new gap, no new events.
  expect(guardEvents(state)).toEqual(['interrupted', 'resumed'])
  expect(state.responses[0]).toMatchObject({ answers: { answer_0: 'Sofort nutzbar' } })
  saveRoundtrip(info, 'observe-correct-display', state)
  expect(state.unexpected).toEqual([])
})

for (const disturbance of ['resize', 'zoom', 'display scale'] as const) {
  test(`@observe ${disturbance} leaves the task usable, keeps only the affected gaze out of AOIs and recovers alone`, async ({
    page,
    context,
  }, info) => {
    const state = await setup(page, [questionnaire()])
    const opened = Date.now()
    await page.goto('/session')
    await page.locator('textarea').fill('Entwurf')
    await expect.poll(() => mappedSince(state, opened).length).toBeGreaterThan(5)
    const cdp = await context.newCDPSession(page)
    const metrics = { width: 1920, height: 1080, screenWidth: 1920, screenHeight: 1080 }
    let restore: () => Promise<unknown>
    if (disturbance === 'resize') {
      await page.setViewportSize({ width: 1600, height: 900 })
      restore = () => page.setViewportSize({ width: 1920, height: 1080 })
    } else if (disturbance === 'zoom') {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 })
      restore = () => cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
    } else {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...metrics,
        mobile: false,
        deviceScaleFactor: 1.25,
      })
      restore = () =>
        cdp.send('Emulation.setDeviceMetricsOverride', {
          ...metrics,
          mobile: false,
          deviceScaleFactor: 1,
        })
    }
    await expect
      .poll(() => guardEvents(state).filter((event) => event === 'interrupted').length)
      .toBe(2)
    await expectNoPersistentDisplayStatus(page)
    const invalidFrom = Date.now()
    // Nothing is held: no dialog, no inert page, and typing goes on.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.locator('textarea').evaluate((el) => Boolean(el.closest('[inert]')))).toBe(
      false,
    )
    await page.locator('textarea').fill('Entwurf, während der Störung weitergeschrieben')
    await expect.poll(() => unmappedSince(state, invalidFrom).length).toBeGreaterThan(5)
    expect(mappedSince(state, invalidFrom)).toEqual([])
    // Settings stay on the welcome page. The questionnaire has no status box,
    // settings launcher or modal even while geometry becomes invalid.
    await expectNoPersistentDisplayStatus(page)
    expect(state.responses).toHaveLength(0)
    const invalidUntil = Date.now()
    await restore()
    await expectNoPersistentDisplayStatus(page)
    const restored = Date.now()
    await expect.poll(() => mappedSince(state, restored).length).toBeGreaterThan(5)
    // The stability window is honoured: nothing is mapped the instant it looks right again.
    const firstMapped = mappedSince(state, invalidUntil)[0]
    expect(firstMapped.ts - invalidUntil).toBeGreaterThanOrEqual(450)
    expect(
      state.samples.filter(
        (sample) =>
          sample.ts > invalidFrom && sample.ts < invalidUntil && sample.geometry_ts !== null,
      ),
    ).toEqual([])
    await expect(page.locator('textarea')).toHaveValue(
      'Entwurf, während der Störung weitergeschrieben',
    )
    expect(state.visits).toHaveLength(1)
    expect(guardEvents(state)).toEqual(['interrupted', 'resumed', 'interrupted', 'resumed'])
    // Raw gaze is complete throughout; only its AOI reference is withheld.
    expect(unmappedSince(state, invalidFrom)[0]).toMatchObject({ lpd: 3.2, rpd: 3.3, lx: 0.5 })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect.poll(() => state.responses.length).toBe(1)
    saveRoundtrip(info, `observe-${disturbance.replace(' ', '-')}`, state, {
      invalid: [invalidFrom, invalidUntil],
    })
    expect(state.unexpected).toEqual([])
  })
}

test('@observe 125% Windows scaling without a measuring bridge: the session runs, the opening check says why gaze is unmapped', async ({
  browser,
  baseURL,
}, info) => {
  // A 15.6" 1920 × 1080 laptop as delivered, in fullscreen.
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1536, height: 864 },
    screen: { width: 1536, height: 864 },
    deviceScaleFactor: 1.25,
  })
  const page = await context.newPage()
  expect(
    await page.evaluate(() => [screen.width, innerWidth, innerHeight, devicePixelRatio]),
  ).toEqual([1536, 1536, 864, 1.25])
  const state = await setup(
    page,
    [{ kind: 'welcome', index: 0, completed: false }, questionnaire(1)],
    420_000,
    { ...nativeFixture(), transport: 'legacy' },
  )
  await page.goto('/session')
  const check = page.locator('details.display-check__section')
  await expect(check.locator('summary')).toContainText('Nicht alle Einstellungen stimmen')
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await expect(check.locator('[data-check="scale"]')).not.toBeVisible()
  await page.screenshot({ path: info.outputPath('opening-check-collapsed.png'), fullPage: true })
  await check.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(check).toHaveAttribute('open', '')
  await expect(check.locator('[data-check="resolution"]')).toContainText('1536 × 864')
  await expect(check.locator('[data-check="resolution"]')).toContainText('1920 × 1080')
  await expect(check.locator('[data-check="scale"]')).toContainText('125 %')
  await expect(check.locator('[data-check="scale"]')).toHaveAttribute('data-status', 'fail')
  await expect(check.locator('[data-check="fullscreen"]')).toHaveCount(0)
  await expect(check.locator('[data-check="bridge"]')).toContainText('ältere Version')
  await expect(check.locator('[data-check="mapping"]')).toContainText('nicht aktiv')
  await expect(check).toContainText('Die Studie kann trotzdem fortgesetzt werden')
  await expectOnlyVerticalDifferences(page)
  await expect(check).toContainText('Skalierung → 100 %')
  await page.screenshot({ path: info.outputPath('opening-check-125-percent.png'), fullPage: true })
  await check.locator('summary').focus()
  await page.keyboard.press('Space')
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  // The check informs; the way on is never withheld.
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.locator('textarea')).toBeVisible()
  const entered = Date.now()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('textarea').fill('Antwort trotz abweichender Anzeige')
  await expect.poll(() => unmappedSince(state, entered).length).toBeGreaterThan(40)
  expect(state.samples.every((sample) => sample.geometry_ts === null)).toBe(true)
  expect(snapshots(state).every((layout) => layout.display_guard?.verified === false)).toBe(true)
  await expectNoPersistentDisplayStatus(page)
  // A setup that stays wrong is one open interval, not a stream of events: the
  // entry boundary, moved back once to the last observation before the page.
  const boundaries = guardEvents(state)
  expect(boundaries.length).toBeLessThanOrEqual(2)
  expect(new Set(boundaries)).toEqual(new Set(['interrupted']))
  await page.waitForTimeout(2000)
  expect(guardEvents(state)).toEqual(boundaries)
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect.poll(() => state.responses.length).toBe(1)
  expect(state.responses[0]).toMatchObject({
    answers: { answer_1: 'Antwort trotz abweichender Anzeige' },
  })
  saveRoundtrip(info, 'observe-125-percent', state)
  expect(state.unexpected).toEqual([])
  await context.close()
})

test('@observe welcome settings open only on request and show changing differences vertically', async ({
  page,
}, info) => {
  const state = await setup(
    page,
    [{ kind: 'welcome', index: 0, completed: false }, questionnaire(1)],
    420_000,
    nativeFixture(0, 0),
  )
  await page.goto('/session')
  const check = page.locator('details.display-check__section')
  const summary = check.locator('summary')
  await expect(summary).toContainText('in Ordnung')
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(check).toHaveAttribute('open', '')
  await expect(check.locator('[data-check]')).toHaveCount(0)
  // Live changes update the expanded list without including successful checks.
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(check.locator('[data-check="browser_area"]')).toContainText('1600 × 900')
  await expect(check.locator('[data-check="browser_area"]')).toHaveAttribute('data-status', 'warn')
  await expect(summary).toContainText('Einige Einstellungen weichen ab')
  await expectOnlyVerticalDifferences(page)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect(summary).toContainText('in Ordnung')
  await expect(check.locator('[data-check]')).toHaveCount(0)
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
  await summary.focus()
  await page.keyboard.press('Space')
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  // A new mismatch must not reopen a section the user closed.
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(summary).toContainText('Einige Einstellungen weichen ab')
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await summary.click()
  await expectOnlyVerticalDifferences(page)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath('opening-differences-mobile.png'), fullPage: true })
  expect(guardEvents(state)).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('@observe unknown welcome settings stay closed and are not reported as all correct', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => undefined })
  })
  const state = await setup(
    page,
    [{ kind: 'welcome', index: 0, completed: false }],
    420_000,
    nativeFixture(0, 0),
  )
  await page.goto('/session')
  const check = page.locator('details.display-check__section')
  await expect(check.locator('summary')).toContainText('noch nicht')
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await check.locator('summary').click()
  await expect(check.locator('[data-check="displays"]')).toHaveAttribute('data-status', 'info')
  await expectOnlyVerticalDifferences(page)
  expect(state.unexpected).toEqual([])
})

test('@observe an unreachable bridge is named on the opening check and does not hold the study', async ({
  page,
}) => {
  const state = await setup(
    page,
    [{ kind: 'welcome', index: 0, completed: false }, questionnaire(1)],
    420_000,
    { ...nativeFixture(), transport: 'offline' },
  )
  await page.goto('/session')
  const check = page.locator('details.display-check__section')
  await expect(check.locator('summary')).toContainText('Nicht alle Einstellungen stimmen')
  expect(await check.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await check.locator('summary').click()
  await expect(check.locator('[data-check="bridge"]')).toContainText('nicht erreichbar')
  await expect(check.locator('[data-check="bridge"]')).toHaveAttribute('data-status', 'fail')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.locator('textarea').fill('Ohne Bridge')
  await expectNoPersistentDisplayStatus(page)
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect.poll(() => state.responses.length).toBe(1)
  expect(state.samples).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('@observe a case video keeps playing through a display change and maps again afterwards', async ({
  page,
}) => {
  const state = await setup(page, [caseVideo])
  const opened = Date.now()
  await page.goto('/session')
  await expect.poll(() => state.screenStarts).toBe(1)
  const video = page.locator('video')
  // The fixture clip lasts two seconds; loop it so that "still playing" means something.
  await video.evaluate((el) => ((el as HTMLVideoElement).loop = true))
  await page.locator('[data-aoi="video_play_pause"]').click()
  await expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true)
  await expect.poll(() => mappedSince(state, opened).length).toBeGreaterThan(5)
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect
    .poll(() => guardEvents(state).filter((event) => event === 'interrupted').length)
    .toBe(2)
  await expectNoPersistentDisplayStatus(page)
  const invalidFrom = Date.now()
  await expect.poll(() => unmappedSince(state, invalidFrom).length).toBeGreaterThan(20)
  expect(await video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(false)
  // The play control still answers while the display is unverified.
  await page.locator('[data-aoi="video_play_pause"]').click()
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
  await page.locator('[data-aoi="video_play_pause"]').click()
  await expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true)
  await page.setViewportSize({ width: 1920, height: 1080 })
  const restored = Date.now()
  await expect.poll(() => mappedSince(state, restored).length).toBeGreaterThan(5)
  await expectNoPersistentDisplayStatus(page)
  // One recording and one screen capture throughout: a display change restarts neither.
  expect(state.recordings).toHaveLength(1)
  expect(state.screenStarts).toBe(1)
  expect(state.unexpected).toEqual([])
})

test('@observe a wrong display does not defer the CK visit or its deadline', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const state = await setup(page, [questionnaire(0, true), questionnaire(1)])
  await page.goto('/session')
  await expect.poll(() => state.visits.length).toBe(1)
  expect(state.timing).not.toBeNull()
  await expect(page.getByRole('timer')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expectNoPersistentDisplayStatus(page)
  expect(state.unexpected).toEqual([])
})

for (const mode of ['windowed', 'fullscreen', 'zoomed'] as const) {
  test(`@observe a measuring bridge maps gaze onto the real DOM areas ${mode}, with no confirmation`, async ({
    page,
  }, info) => {
    const native = nativeFixture(mode === 'fullscreen' ? 0 : 120, mode === 'fullscreen' ? 0 : 90)
    const dpr = mode === 'zoomed' ? 1.25 : 1
    await page.addInitScript((scale) => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => scale })
      Object.defineProperty(window.screen, 'width', { configurable: true, get: () => 1920 })
      Object.defineProperty(window.screen, 'height', { configurable: true, get: () => 1080 })
    }, dpr)
    await page.setViewportSize(
      mode === 'fullscreen' ? { width: 1920, height: 1080 } : { width: 1152, height: 640 },
    )
    const state = await setup(page, [questionnaire()], 420_000, native)
    await page.goto('/session')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.locator('textarea').fill('Gemessen ohne Bestätigung')
    await expect
      .poll(() => snapshots(state).some((layout) => layout.display_guard?.verified))
      .toBe(true)
    await expectNoPersistentDisplayStatus(page)
    const target = await page.locator('textarea').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        aoi: el.closest('[data-aoi]')?.getAttribute('data-aoi'),
      }
    })
    const proof = native.proof!
    native.gaze = [
      (proof.content.x + target.x * proof.dpr) / proof.display.w,
      (proof.content.y + target.y * proof.dpr) / proof.display.h,
    ]
    const from = Date.now()
    await expect.poll(() => mappedSince(state, from + 100).length).toBeGreaterThan(5)
    for (const row of mappedSince(state, from + 100)) {
      const geometry = snapshots(state).find((layout) => layout.ts === row.geometry_ts) as
        | (Record<string, unknown> & {
            aois: Array<{ id: string; x: number; y: number; w: number; h: number }>
          })
        | undefined
      expect(geometry).toMatchObject({
        display_guard: { profile: 'native_viewport_v1', verified: true },
      })
      const x = (row.lx * proof.display.w - proof.content.x) / proof.dpr
      const y = (row.ly * proof.display.h - proof.content.y) / proof.dpr
      const area = geometry!.aois.find((aoi) => aoi.id === target.aoi)!
      expect(x).toBeGreaterThanOrEqual(area.x)
      expect(x).toBeLessThan(area.x + area.w)
      expect(y).toBeGreaterThanOrEqual(area.y)
      expect(y).toBeLessThan(area.y + area.h)
    }
    expect(state.layouts.length).toBeLessThan(20)
    saveRoundtrip(info, `observe-native-${mode}`, state, { expected_aoi: target.aoi, from })
    expect(state.unexpected).toEqual([])
  })
}

test('@observe a scrollbar appearing or disappearing is not a display change', async ({ page }) => {
  const state = await setup(page, [questionnaire()])
  const opened = Date.now()
  await page.goto('/session')
  await page.locator('textarea').fill('Entwurf')
  await expect.poll(() => mappedSince(state, opened).length).toBeGreaterThan(5)
  expect(guardEvents(state)).toEqual(['interrupted', 'resumed'])
  // Windows draws scrollbars that take layout space; headless Chromium hides
  // them, so give this page ones that behave the same way.
  await page.addStyleTag({ content: '::-webkit-scrollbar { width: 17px; height: 17px; }' })
  await page.evaluate(() => {
    const log = ((window as unknown as { resizes: string[] }).resizes = [] as string[])
    window.addEventListener('resize', () => log.push('window'))
    window.visualViewport?.addEventListener('resize', () => log.push('visualViewport'))
  })
  const widths: number[] = []
  for (const height of ['4000px', '', '4000px', '']) {
    await page.evaluate((value) => {
      document.documentElement.style.minHeight = value
    }, height)
    widths.push(await page.evaluate(() => document.documentElement.clientWidth))
    await page.waitForTimeout(300)
  }
  // The fixture must really toggle a layout-affecting scrollbar to mean anything.
  expect(new Set(widths).size).toBe(2)
  // That is the one event Windows fires for it, and the window itself stays silent.
  expect(await page.evaluate(() => (window as unknown as { resizes: string[] }).resizes)).toEqual([
    'visualViewport',
    'visualViewport',
    'visualViewport',
    'visualViewport',
  ])
  const settled = Date.now()
  await expect.poll(() => mappedSince(state, settled).length).toBeGreaterThan(5)
  expect(guardEvents(state)).toEqual(['interrupted', 'resumed'])
  // Window size, position and zoom were untouched, so no sample lost its layout.
  const first = mappedSince(state, opened)[0].ts
  expect(
    state.samples.filter((sample) => sample.ts > first && sample.geometry_ts === null),
  ).toEqual([])
  await expectNoPersistentDisplayStatus(page)
  expect(state.unexpected).toEqual([])
})

test('@observe a case with an unreachable bridge has no persistent status boxes', async ({
  page,
}, info) => {
  const state = await setup(page, [caseVideo], 420_000, {
    ...nativeFixture(),
    transport: 'offline',
  })
  await page.goto('/session')
  await expect(page.locator('video')).toBeVisible()
  await expectNoPersistentDisplayStatus(page)
  await expect(page.locator('.gaze-health-stack')).toHaveCount(0)
  await expect(page.locator('[data-aoi="video_controls"]')).toBeInViewport({ ratio: 1 })
  await expect(page.locator('[data-aoi="continue"]')).toBeInViewport({ ratio: 1 })
  await page.locator('[data-aoi="notes"] textarea').fill('Notizen ohne technische Statusboxen')
  await page.screenshot({
    path: info.outputPath('case-unreachable-bridge-clean.png'),
    fullPage: true,
  })
  expect(state.samples).toEqual([])
  expect(state.unexpected).toEqual([])
})
