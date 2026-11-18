import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'

import type { SessionStep } from '../src/api/participant'
import type { GazeLayout } from '../src/lib/gazeGeometry'
import type { Question } from '../src/lib/questionnaire'

const API = 'http://a04.invalid'
test.use({ viewport: { width: 1920, height: 1080 }, screen: { width: 1920, height: 1080 } })
const clip = readFileSync(new URL('./fixtures/stimulus.webm', import.meta.url))
const source = JSON.parse(
  readFileSync(
    new URL('../../backend/app/data/pretest_pilot20261116.json', import.meta.url),
    'utf8',
  ),
) as {
  ck_tasks: { question: Question }[]
  pck_pages: { source_task: number; title: string; description: string; questions: Question[] }[]
  mesp_pages: { source_task: number; title: string; description: string; questions: Question[] }[]
}

function questionnaire(questions: Question[], section = 'pck', description = ''): SessionStep {
  return {
    kind: 'questionnaire',
    index: 0,
    completed: false,
    questionnaire_id: 1,
    placement: 'pre_test',
    title: 'AOI-Prüfung',
    description,
    section,
    section_key: section,
    video_id: null,
    page: 1,
    page_count: 1,
    questions,
  }
}

async function openStep(page: Page, step: SessionStep) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'a04_auth',
      JSON.stringify({
        token: `e30.${btoa(JSON.stringify({ sub: 'AOI-INVENTORY', role: 'participant', exp: 4_000_000_000 }))}.test`,
      }),
    )
    localStorage.setItem('i18nextLng', 'de')
  })
  const state = {
    layouts: [] as GazeLayout[],
    samples: [] as unknown[],
    unexpected: [] as string[],
  }
  await page.routeWebSocket('ws://127.0.0.1:8766', (ws) => {
    ws.send(
      JSON.stringify({ type: 'status', connected: true, frequency: 120, screen_recording: false }),
    )
    let timer: ReturnType<typeof setInterval> | undefined
    ws.onMessage((message) => {
      const command = JSON.parse(String(message)).type
      if (command === 'start_gaze' && !timer)
        timer = setInterval(
          () =>
            ws.send(
              JSON.stringify({
                type: 'gaze',
                ts: Date.now(),
                lx: 0.5,
                ly: 0.5,
                rx: 0.5,
                ry: 0.5,
                lv: true,
                rv: true,
              }),
            ),
          50,
        )
      if (command === 'stop_gaze') {
        clearInterval(timer)
        timer = undefined
      }
    })
    ws.onClose(() => clearInterval(timer))
  })
  const timing =
    step.kind === 'questionnaire' && step.section_key === 'ck_tasks'
      ? {
          section_key: 'ck_tasks',
          duration_seconds: 420,
          deadline_ms: Date.now() + 420_000,
          server_now_ms: Date.now(),
          finished: false,
          started_client_ts: Date.now(),
          ended_client_ts: null,
        }
      : null
  await page.route(API + '/**', async (route) => {
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
    if (path === '/participant/me') return json({ id: 'AOI-INVENTORY', status: 'active' })
    if (path === '/participant/session')
      return json({
        flow_version: 'pilot_20261116',
        current_step_index: 0,
        status: 'active',
        total_steps: 1,
        section_timing: timing,
        steps: [step],
      })
    if (path === '/participant/session/questionnaire-visit')
      return json({ visit_id: request.postDataJSON().visit_id, section_timing: timing })
    if (path === '/participant/events') return json({ id: 1 })
    if (path.endsWith('/notes')) return json([])
    if (path.endsWith('/url')) return json({ signed_url: API + '/stimulus.webm' })
    if (path === '/stimulus.webm') return route.fulfill({ contentType: 'video/webm', body: clip })
    if (path === '/gaze/recordings') {
      state.layouts.push(request.postDataJSON().geometry)
      return json({ recording_id: 1 })
    }
    if (path === '/gaze/recordings/1/geometry') {
      state.layouts.push(request.postDataJSON())
      return json({ status: 'ok' })
    }
    if (path === '/gaze/recordings/1/samples') {
      state.samples.push(...request.postDataJSON().samples)
      return json({ status: 'ok' })
    }
    if (path === '/gaze/recordings/1/complete') return json({ status: 'ok' })
    if (path === '/gaze/videos/1/replay')
      return json({
        video_url: API + '/stimulus.webm',
        source: 'screen',
        recording_pending: false,
        sampling_rate_hz: 120,
        plotted_points: 2,
        invalid_samples: 0,
        unmapped_samples: 0,
        offscreen_samples: 0,
        has_geometry: true,
        points: [
          { t: 0, x: 0.25, y: 0.75 },
          { t: 2000, x: 0.25, y: 0.75 },
        ],
        epoch_ms: Date.now(),
        duration_ms: 2000,
        recorder: 'bridge',
        audio_status: 'captured',
      })
    state.unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto('/session')
  await page.evaluate(() => document.fonts.ready)
  if (step.kind !== 'think_aloud')
    await expect.poll(() => state.samples.length).toBeGreaterThan(0)
  await expect(page.locator('.unsent')).toHaveCount(0)
  if (step.kind !== 'think_aloud')
    await expect
      .poll(() => state.layouts.at(-1)?.aois?.some((area) => area.id === 'unsent_notice'))
      .toBe(false)
  return state
}

function hit(layout: GazeLayout, point: { x: number; y: number }) {
  return (
    layout.aois
      ?.map((area, index) => ({ ...area, index }))
      .filter(
        (area) =>
          point.x >= area.x &&
          point.x < area.x + area.w &&
          point.y >= area.y &&
          point.y < area.y + area.h,
      )
      .sort((a, b) => b.priority - a.priority || b.index - a.index)[0]?.id ?? null
  )
}

async function verifyInventory(
  page: Page,
  layouts: GazeLayout[],
  info: TestInfo,
  name: string,
  clipped = false,
) {
  // The browser supplies independent DOM rectangles. These lab-sized tasks do
  // not scroll internally; clipped/scrolled tables have their own test below.
  const expected = await page.locator('[data-aoi]').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none')
        return []
      const x = Math.max(0, box.left),
        y = Math.max(0, box.top),
        right = Math.min(innerWidth, box.right),
        bottom = Math.min(innerHeight, box.bottom)
      if (right <= x || bottom <= y) return []
      return [{ id: element.getAttribute('data-aoi'), x, y, w: right - x, h: bottom - y }]
    }),
  )
  await expect
    .poll(() => {
      const actual = layouts.at(-1)?.aois ?? []
      if (clipped)
        return (
          actual.length > 0 &&
          actual.every((area) =>
            expected.some(
              (wanted) =>
                area.id === wanted.id &&
                area.x >= wanted.x - 1 &&
                area.y >= wanted.y - 1 &&
                area.x + area.w <= wanted.x + wanted.w + 1 &&
                area.y + area.h <= wanted.y + wanted.h + 1,
            ),
          )
        )
      return expected.every((wanted) =>
        actual.some(
          (area) =>
            area.id === wanted.id &&
            ['x', 'y', 'w', 'h'].every(
              (key) => Math.abs(area[key as 'x'] - wanted[key as 'x']) < 1,
            ),
        ),
      )
    })
    .toBe(true)
  const layout = layouts.at(-1)!
  const points = await page.evaluate((areas) => {
    // Status cards intentionally let mouse clicks pass through. Enable hit
    // testing only during this measurement to inspect their painted order.
    const overlays = [...document.querySelectorAll<HTMLElement>('[data-aoi-overlay]')]
    const original = overlays.map((element) => element.style.pointerEvents)
    overlays.forEach((element) => {
      element.style.pointerEvents = 'auto'
    })
    const points = areas.map((area) => {
      const x = area.x + area.w / 2,
        y = area.y + area.h / 2
      return {
        x,
        y,
        expected:
          document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-aoi]')?.dataset.aoi ?? null,
      }
    })
    overlays.forEach((element, index) => {
      element.style.pointerEvents = original[index]
    })
    return points
  }, layout.aois ?? [])
  for (const point of points)
    expect(hit(layout, point), `${name}: painted center ${point.x},${point.y}`).toBe(point.expected)
  await info.attach(`${name}-geometry`, {
    body: JSON.stringify({ layout, points }, null, 2),
    contentType: 'application/json',
  })
  writeFileSync(
    info.outputPath(`${name}-geometry.json`),
    JSON.stringify({ layout, points }, null, 2),
  )
  return layout
}

for (const task of source.ck_tasks) {
  test(`AOI inventory: ${task.question.id}`, async ({ page }, info) => {
    const state = await openStep(page, questionnaire([task.question], 'ck_tasks'))
    const layout = await verifyInventory(page, state.layouts, info, task.question.id)
    for (const suffix of ['', '.prompt', '.code', '.answer'])
      expect(layout.aois?.some((area) => area.id === `question.${task.question.id}${suffix}`)).toBe(
        true,
      )
    expect(layout.aois?.some((area) => area.id === 'skip')).toBe(true)
    expect(layout.aois?.some((area) => area.id === 'section_timer')).toBe(true)
    expect(state.unexpected).toEqual([])
  })
}

for (const section of ['pck', 'mesp'] as const)
  for (const task of source[`${section}_pages`]) {
    test(`AOI inventory: ${section} task ${task.source_task}`, async ({ page }, info) => {
      const state = await openStep(page, questionnaire(task.questions, section, task.description))
      const layout = await verifyInventory(
        page,
        state.layouts,
        info,
        `${section}-${task.source_task}`,
      )
      for (const question of task.questions) {
        for (const suffix of ['.prompt', '.answer'])
          expect(layout.aois?.some((area) => area.id === `question.${question.id}${suffix}`)).toBe(
            true,
          )
        if (question.matrix_prompt)
          expect(layout.aois?.some((area) => area.id === `matrix.${question.matrix}.prompt`)).toBe(
            true,
          )
      }
      if (section === 'mesp')
        expect(layout.aois?.filter((area) => area.id.endsWith('.legend'))).toHaveLength(6)
      expect(state.unexpected).toEqual([])
    })
  }

test('AOIs cover all other field types, conditional visibility and changed answer geometry', async ({
  page,
}, info) => {
  const types = [
    'likert',
    'multiple_choice',
    'multi_select',
    'free_text',
    'slider',
    'number',
    'line_numbers',
    'ranking',
  ] as const
  const questions: Question[] = types.map((type) => ({
    id: type,
    type,
    text: type,
    options: ['A', 'B', 'C'],
    required: false,
    min: 1,
    max: 5,
  }))
  questions.push({
    id: 'conditional',
    type: 'free_text',
    text: 'Bedingte Frage',
    show_if: { question: 'multiple_choice', equals: 'B' },
  })
  const state = await openStep(page, questionnaire(questions, 'demographics'))
  expect(state.layouts.at(-1)?.aois?.some((area) => area.id.includes('conditional'))).toBe(false)
  await page
    .locator('[data-aoi="question.multiple_choice"]')
    .getByRole('radio', { name: 'B', exact: true })
    .check()
  await page.locator('[data-aoi="question.conditional.answer"]').scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      state.layouts.at(-1)?.aois?.some((area) => area.id === 'question.conditional.answer'),
    )
    .toBe(true)
  await page
    .locator('[data-aoi="question.line_numbers"]')
    .getByRole('button', { name: /Fehler bezieht/ })
    .click()
  await expect(page.locator('[data-aoi="question.line_numbers"] input')).toHaveCount(2)
  for (const question of questions) {
    await page.locator(`[data-aoi="question.${question.id}.answer"]`).scrollIntoViewIfNeeded()
    await expect
      .poll(() =>
        state.layouts.at(-1)?.aois?.some((area) => area.id === `question.${question.id}.answer`),
      )
      .toBe(true)
  }
  await verifyInventory(page, state.layouts, info, 'scrolled-fields')
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect.poll(() => state.layouts.at(-1)?.window.inner_w).toBe(1280)
  await verifyInventory(page, state.layouts, info, 'resized-fields')
})

test('case AOIs and all case/supervisor dialogs follow the foreground', async ({ page }, info) => {
  const step: SessionStep = {
    kind: 'case_video',
    index: 0,
    completed: false,
    case_number: 1,
    case_total: 7,
    video_id: 1,
    task_description: 'Beobachten Sie den Fall.',
    info_text: 'Definition.',
    student_task_text: '```java\nint value = 1;\n```',
    time_limit_seconds: 600,
  }
  const state = await openStep(page, step)
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThan(0)
  const layout = await verifyInventory(page, state.layouts, info, 'case')
  for (const id of [
    'video',
    'video_controls',
    'video_play_pause',
    'video_seek',
    'phase_label',
    'timer',
    'task',
    'info_button',
    'student_task_button',
    'notes',
    'continue',
  ])
    expect(layout.aois?.some((area) => area.id === id)).toBe(true)
  for (const [button, modal] of [
    ['info_button', 'info_dialog'],
    ['student_task_button', 'student_task_dialog'],
    ['continue', 'case_exit_dialog'],
  ]) {
    await page.locator(`[data-aoi="${button}"]`).click()
    await expect.poll(() => state.layouts.at(-1)?.active_modal).toBe(modal)
    await expect.poll(() => state.layouts.at(-1)?.aois?.map((area) => area.id)).toEqual([modal])
    await info.attach(modal, {
      body: JSON.stringify(state.layouts.at(-1)),
      contentType: 'application/json',
    })
    await page.keyboard.press('Escape')
    await expect.poll(() => state.layouts.at(-1)?.active_modal).toBeNull()
  }
  await page.keyboard.press('Control+Alt+Shift+KeyB')
  await expect.poll(() => state.layouts.at(-1)?.active_modal).toBe('supervisor_dialog')
  expect(state.layouts.at(-1)?.aois?.map((area) => area.id)).toEqual(['supervisor_dialog'])
  expect(state.unexpected).toEqual([])
})

for (const kind of ['diagnosis', 'case_outro'] as const)
  test(`AOI inventory: ${kind}`, async ({ page }, info) => {
    const questions: Question[] = [
      { id: 'confidence', type: 'likert', text: 'Sicherheit', scale_min: 1, scale_max: 5 },
    ]
    const step: SessionStep =
      kind === 'diagnosis'
        ? {
            kind,
            index: 0,
            completed: false,
            video_id: 1,
            title: 'Diagnose',
            task_description: '',
            section: 'Sicherheit',
            questions,
          }
        : {
            kind,
            index: 0,
            completed: false,
            video_id: 1,
            phase_type: 'training',
            questionnaire_id: 2,
            title: 'Nach dem Fall',
            section: 'Aufwand',
            instruction: 'Bewerten Sie den Fall.',
            questions,
          }
    const state = await openStep(page, step)
    const layout = await verifyInventory(page, state.layouts, info, kind)
    for (const id of kind === 'diagnosis'
      ? ['diagnosis_prompt', 'diagnosis_answer', 'notes', 'continue']
      : ['instructions', 'question.confidence.prompt', 'question.confidence.answer', 'continue'])
      expect(layout.aois?.some((area) => area.id === id)).toBe(true)
  })

for (const scale of [1, 1.25, 1.5])
  test(`matrix geometry at display scale ${scale}`, async ({ browser, baseURL }, info) => {
    const viewport = { width: Math.round(1920 / scale), height: Math.round(1080 / scale) }
    const context = await browser.newContext({
      baseURL,
      viewport,
      screen: viewport,
      deviceScaleFactor: scale,
    })
    const page = await context.newPage()
    try {
      const task = source.mesp_pages[0]
      const state = await openStep(page, questionnaire(task.questions, 'mesp', task.description))
      const layout = await verifyInventory(page, state.layouts, info, `scale-${scale}`, scale > 1)
      expect(layout.dpr).toBe(scale)
      expect(layout.screen).toMatchObject({ w: viewport.width, h: viewport.height })
      await page.locator('.matrix__scroll').evaluate((element) => {
        element.scrollLeft = element.scrollWidth
      })
      const row = page.locator('[data-aoi="question.mesp_pre_1a.prompt"]')
      const prompt = await row.boundingBox()
      await expect
        .poll(() =>
          state.layouts
            .at(-1)
            ?.aois?.filter((area) => area.id === 'question.mesp_pre_1a.answer')
            .every((area) => area.x >= prompt!.x + prompt!.width - 1),
        )
        .toBe(true)
      const recorded = state.layouts.at(-1)!
      await info.attach(`scale-${scale}-scrolled`, {
        body: JSON.stringify(recorded),
        contentType: 'application/json',
      })
    } finally {
      await context.close()
    }
  })

test('visual viewport zoom is retained so unsupported mapping can be rejected', async ({
  page,
  context,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Pinch-zoom emulation uses the Chromium DevTools protocol.')
  const state = await openStep(
    page,
    questionnaire([{ id: 'answer', type: 'free_text', text: 'Antwort' }], ''),
  )
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 })
  await expect.poll(() => state.layouts.at(-1)?.visual_viewport?.scale).toBe(1.5)
  await info.attach('pinch-zoom-geometry', {
    body: JSON.stringify(state.layouts.at(-1)),
    contentType: 'application/json',
  })
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
  await expect.poll(() => state.layouts.at(-1)?.visual_viewport?.scale).toBe(1)
})

test('a retained gaze delivery failure does not add a task overlay or cover its answer', async ({
  page,
}, info) => {
  const state = await openStep(
    page,
    questionnaire([{ id: 'answer', type: 'free_text', text: 'Antwort' }], ''),
  )
  // Recording delivery retains its failure state without placing technical UI
  // over the participant's next task.
  await page.evaluate(async () => {
    const modulePath = '/src/lib/gazeDelivery.ts'
    const { reportGazeDelivery } = await import(modulePath)
    reportGazeDelivery('upload_failed')
  })
  await expect(
    page.locator(
      '[data-aoi="gaze_delivery"], [data-aoi="gaze_health"], [data-aoi="display_check_notice"]',
    ),
  ).toHaveCount(0)
  await page.locator('textarea').fill('Antwort bleibt erreichbar')
  await expect(page.locator('textarea')).toHaveValue('Antwort bleibt erreichbar')
  await verifyInventory(page, state.layouts, info, 'gaze-delivery-without-overlay')
  expect(state.layouts.at(-1)?.aois?.some((area) => area.id === 'gaze_delivery')).toBe(false)
})

test('replay gaze follows the rendered picture through resize, fullscreen and visibility toggle', async ({
  page,
}, info) => {
  const state = await openStep(page, {
    kind: 'think_aloud',
    index: 0,
    completed: false,
    video_id: 1,
    phase_type: 'training',
    case_number: 5,
    case_total: 7,
    batch_position: 1,
    batch_size: 3,
    heading: '',
    body: '',
  })
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThan(0)
  const check = async (name: string) => {
    await expect
      .poll(() => page.locator('.gaze-dot').evaluate((dot) => getComputedStyle(dot).opacity))
      .toBe('1')
    const measure = () =>
      page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>('video')!,
          box = video.getBoundingClientRect(),
          dot = document.querySelector('.gaze-dot')!.getBoundingClientRect()
        const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight)
        const w = video.videoWidth * scale,
          h = video.videoHeight * scale
        return {
          expected: {
            x: box.x + (box.width - w) / 2 + w * 0.25,
            y: box.y + (box.height - h) / 2 + h * 0.75,
          },
          actual: { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 },
        }
      })
    await expect
      .poll(async () => {
        const geometry = await measure()
        return Math.max(
          Math.abs(geometry.actual.x - geometry.expected.x),
          Math.abs(geometry.actual.y - geometry.expected.y),
        )
      })
      .toBeLessThan(0.5)
    const geometry = await measure()
    await info.attach(name, { body: JSON.stringify(geometry), contentType: 'application/json' })
  }
  await check('replay-lab')
  await page.setViewportSize({ width: 1280, height: 720 })
  await check('replay-resized')
  await page.getByRole('button', { name: 'Vollbild', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe('replay__stage')
  await check('replay-fullscreen')
  await page.getByRole('button', { name: 'Vollbild verlassen', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).uncheck()
  await expect
    .poll(() => page.locator('.gaze-dot').evaluate((dot) => getComputedStyle(dot).opacity))
    .toBe('0')
  expect(state.layouts).toEqual([])
  expect(state.unexpected).toEqual([])
})
