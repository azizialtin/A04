import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { SessionStep } from '../src/api/participant'
import type { GazeLayout } from '../src/lib/gazeGeometry'
import { expectNoHorizontalOverflow } from './layout'

const API = 'http://a04.invalid'
const code =
  '```java\nint a = 1;\nint b = 2;\n```\nEin zusammenhängendes Programm:\n```java\nint c = a + b;\nSystem.out.println(c);\n```'
const steps: SessionStep[] = [
  {
    index: 0,
    completed: false,
    kind: 'questionnaire',
    questionnaire_id: 4,
    placement: 'pre_test',
    title: 'Fehler im Code',
    description: code,
    section: 'Debugging',
    video_id: null,
    page: 1,
    page_count: 1,
    questions: [
      { id: 'lines', type: 'line_numbers', text: 'Fehler in Zeilennummer', min: 1, max: 4 },
      { id: 'reason', type: 'free_text', text: 'Begründung', required: false },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `extra_${i}`,
        type: 'number' as const,
        text: `Weitere Frage ${i + 1}`,
        required: false,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `matrix_${i}`,
        type: 'multiple_choice' as const,
        matrix: 'knowledge',
        text: `Aussage ${i + 1} zum Wissen über Programmierung`,
        options: Array.from({ length: 10 }, (_, n) => ({ value: n, label: `Antwort ${n + 1}` })),
        required: false,
      })),
    ],
  },
  {
    index: 1,
    completed: false,
    kind: 'case_intro',
    phase_type: 'pre_test',
    video_id: 7,
    title: 'Fall starten',
    body: 'Bitte sehen Sie sich den Fall an.',
  },
  {
    index: 2,
    completed: false,
    kind: 'case_video',
    video_id: 7,
    title: 'Fall 1',
    task_description: 'Beobachten Sie die Vorgehensweise und notieren Sie Ihre Diagnose.',
    info_text: 'Die Schülerinnen und Schüler bearbeiten eine Java-Aufgabe.',
    student_task_text: code,
    time_limit_seconds: 600,
  },
  {
    index: 3,
    completed: false,
    kind: 'diagnosis',
    video_id: 7,
    title: 'Diagnose',
    task_description: 'Beschreiben Sie den Fehler.',
    section: 'Sicherheit',
    questions: [{ id: 'confidence', type: 'number', text: 'Sicherheit', required: false }],
  },
  {
    index: 4,
    completed: false,
    kind: 'case_outro',
    video_id: 7,
    phase_type: 'pre_test',
    questionnaire_id: 5,
    title: 'Nach dem Fall',
    section: 'Aufwand',
    instruction: 'Bewerten Sie den Fall.',
    questions: [{ id: 'effort', type: 'number', text: 'Aufwand', required: false }],
  },
  { index: 5, completed: false, kind: 'thanks' },
]

async function identity(page: Page, role = 'participant') {
  await page.addInitScript((kind) => {
    const token = `e30.${btoa(JSON.stringify({ sub: 'TEST-UI', role: kind, exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
  }, role)
}

async function participant(page: Page, initial = 0, bridge = true, sessionSteps = steps) {
  await identity(page)
  // Synthetic tracker samples use a display matching the test viewport. Real
  // fullscreen/zoom enforcement is covered by DisplayGuard's own tests.
  await page.addInitScript(() => {
    Object.defineProperty(screen, 'width', { get: () => innerWidth })
    Object.defineProperty(screen, 'height', { get: () => innerHeight })
    // Ordinary UI checks decline display capture. The dedicated capture test
    // installs its own stream; never leave an OS picker waiting in Firefox.
    if (!Object.hasOwn(navigator.mediaDevices, 'getDisplayMedia')) {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
          throw new DOMException('Display capture declined by test fixture', 'NotAllowedError')
        },
      })
    }
  })
  let current = initial
  let nextRecording = 0
  const recordings: {
    id: number
    kind: string
    layouts: GazeLayout[]
    completed: boolean
    samples: unknown[]
  }[] = []
  const answers: Record<string, unknown>[] = []
  const events: { event_type: string; client_ts: number; payload: Record<string, unknown> }[] = []
  const bridgeCommands: string[] = []
  const screenStarts: Record<string, unknown>[] = []
  const screenUploads: Buffer[] = []
  const unexpected: string[] = []
  await page.routeWebSocket('ws://127.0.0.1:8766', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'status',
        connected: bridge,
        frequency: 120,
        screen_recording: false,
      }),
    )
    ws.onMessage((message) => {
      const request = JSON.parse(String(message))
      bridgeCommands.push(request.type)
      if (request.type === 'start_gaze' && bridge) {
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
        )
      }
    })
  })
  await page.route(`${API}/**`, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const method = req.method()
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, json: data, headers: { 'Access-Control-Allow-Origin': '*' } })
    if (method === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
      })
    if (path === '/participant/me')
      return json({ id: 'TEST-UI', status: 'active', study_name: 'Browserprüfung' })
    if (path === '/participant/session')
      return json({
        status: 'active',
        current_step_index: current,
        total_steps: sessionSteps.length,
        steps: sessionSteps,
      })
    if (path === '/participant/session/progress') {
      current = req.postDataJSON().current_step_index
      return json({
        status: 'active',
        current_step_index: current,
        total_steps: sessionSteps.length,
        complete: false,
      })
    }
    if (path.endsWith('/respond')) {
      answers.push(req.postDataJSON())
      return json({ status: 'ok' })
    }
    if (path === '/participant/events') {
      events.push(req.postDataJSON())
      return json({ id: 1 })
    }
    if (path === '/participant/notes' || path === '/participant/diagnosis') return json({ id: 1 })
    if (path.endsWith('/notes')) return json([])
    if (path.endsWith('/replay'))
      return json({
        video_url: `${API}/test-video.mp4`,
        source: 'clip',
        sampling_rate_hz: 0,
        plotted_points: 0,
        invalid_samples: 0,
        unmapped_samples: 0,
        offscreen_samples: 0,
        has_geometry: false,
        points: [],
        epoch_ms: null,
        duration_ms: null,
        recorder: null,
      })
    if (path.endsWith('/url')) return json({ signed_url: `${API}/test-video.mp4` })
    if (path === '/test-video.mp4')
      return route.fulfill({
        status: 200,
        contentType: 'video/webm',
        body: await readFile(new URL('./fixtures/stimulus.webm', import.meta.url)),
      })
    if (path === '/gaze/recordings') {
      const body = req.postDataJSON()
      const id = ++nextRecording
      recordings.push({
        id,
        kind: body.step_kind,
        layouts: [body.geometry],
        completed: false,
        samples: [],
      })
      return json({ recording_id: id }, 201)
    }
    const gaze = /^\/gaze\/recordings\/(\d+)\/(geometry|samples|complete)$/.exec(path)
    if (gaze) {
      const rec = recordings.find((r) => r.id === Number(gaze[1]))!
      if (gaze[2] === 'geometry') rec.layouts.push(req.postDataJSON())
      if (gaze[2] === 'samples') rec.samples.push(...req.postDataJSON().samples)
      if (gaze[2] === 'complete') rec.completed = true
      return json({ status: 'ok' })
    }
    if (path === '/screen/recordings') {
      screenStarts.push(req.postDataJSON())
      return json({ recording_id: 99, upload_token: 'test-upload-token' }, 201)
    }
    if (path.endsWith('/upload-url')) return json({ mode: 'local' })
    if (path.endsWith('/upload')) {
      screenUploads.push(req.postDataBuffer()!)
      return json({ status: 'ok' })
    }
    if (path.endsWith('/failed')) return json({ status: 'ok' })
    unexpected.push(`${method} ${path}`)
    return json({ detail: 'Unexpected test request' }, 400)
  })
  return {
    recordings,
    answers,
    events,
    bridgeCommands,
    screenStarts,
    screenUploads,
    unexpected,
    setStep: (index: number) => {
      current = index
    },
  }
}

async function verifyBounds(page: Page, geometry: GazeLayout) {
  const expected = await page.locator('[data-aoi]').evaluateAll((els) =>
    els
      .flatMap((el) => {
        const rect = el.getBoundingClientRect()
        if (el instanceof HTMLVideoElement && el.hasAttribute('data-gaze-video')) {
          if (!el.videoWidth || !el.videoHeight) return []
          const scale = Math.min(rect.width / el.videoWidth, rect.height / el.videoHeight)
          const width = el.videoWidth * scale
          const height = el.videoHeight * scale
          const left = rect.left + (rect.width - width) / 2
          const top = rect.top + (rect.height - height) / 2
          return ['video_students', 'video_code'].map((id, half) => ({
            id,
            x: Math.max(0, left + (half * width) / 2),
            y: Math.max(0, top),
            right: Math.min(innerWidth, left + ((half + 1) * width) / 2),
            bottom: Math.min(innerHeight, top + height),
          }))
        }
        const margin = Math.min(8, Number(el.getAttribute('data-aoi-margin')) || 0)
        return {
          id: el.getAttribute('data-aoi'),
          x: Math.max(0, rect.left - margin),
          y: Math.max(0, rect.top - margin),
          right: Math.min(innerWidth, rect.right + margin),
          bottom: Math.min(innerHeight, rect.bottom + margin),
        }
      })
      .filter((box) => box.right > box.x && box.bottom > box.y),
  )
  for (const aoi of geometry.aois ?? []) {
    const box = expected.find(
      (e) => e.id === aoi.id && Math.abs(e.x - aoi.x) < 1 && Math.abs(e.y - aoi.y) < 1,
    )
    expect(box, `DOM bounds for ${aoi.id}`).toBeTruthy()
    expect(aoi.w).toBeCloseTo(box!.right - box!.x, 0)
    expect(aoi.h).toBeCloseTo(box!.bottom - box!.y, 0)
  }
}

async function settledGeometry(page: Page, latest: () => GazeLayout | undefined) {
  let verified: GazeLayout | undefined
  // DOM changes and video metadata can arrive before the next measured layout
  // finishes uploading. Compare the current snapshot on each retry, retaining
  // every coordinate assertion rather than accepting the first stale snapshot.
  await expect(async () => {
    const geometry = latest()
    expect(geometry).toBeDefined()
    await verifyBounds(page, geometry!)
    verified = geometry
  }).toPass({ timeout: 5000 })
  return verified!
}

async function redOverlay(page: Page, geometry: GazeLayout, info: TestInfo, name: string) {
  await writeFile(info.outputPath(`${name}-layout.json`), JSON.stringify(geometry, null, 2))
  await page.evaluate((aois) => {
    for (const aoi of aois ?? []) {
      const overlay = document.createElement('div')
      overlay.dataset.aoiVerification = 'true'
      overlay.textContent = aoi.id
      Object.assign(overlay.style, {
        position: 'fixed',
        left: `${aoi.x}px`,
        top: `${aoi.y}px`,
        width: `${aoi.w}px`,
        height: `${aoi.h}px`,
        boxSizing: 'border-box',
        border: '1px solid red',
        background: 'rgba(255, 0, 0, .13)',
        color: '#9d0015',
        zIndex: '2147483647',
        pointerEvents: 'none',
        font: '11px monospace',
        overflow: 'hidden',
      })
      document.body.append(overlay)
    }
  }, geometry.aois)
  await page.screenshot({ path: info.outputPath(`${name}-red.png`) })
  await page
    .locator('[data-aoi-verification]')
    .evaluateAll((els) => els.forEach((el) => el.remove()))
  await expect(page.locator('[data-aoi-verification]')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath(`${name}-clean.png`) })
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`case AOIs follow DOM and modal visibility at ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    const sessionSteps = structuredClone(steps)
    const caseStep = sessionSteps[2]
    // Existing study content also stores code as labelled JSON string arrays.
    // Exercise that representation as well as ordinary Markdown fences.
    if (viewport.width === 1920 && caseStep.kind === 'case_video') {
      caseStep.student_task_text = [
        'Lies den gegebenen Code.',
        'Gegebener Code (JSON-Format):',
        '',
        'Codeblock 1:',
        JSON.stringify(['int a = 1;', 'int b = 2;'], null, 2),
        '',
        'Codeblock 2:',
        JSON.stringify(['int c = a + b;', 'System.out.println(c);'], null, 2),
      ].join('\n')
    }
    const data = await participant(page, 2, true, sessionSteps)
    await page.goto('/session')
    await expect(page.locator('video[data-gaze-video]')).toBeVisible()
    await expect(page.locator('[data-aoi="continue"]')).toBeInViewport({ ratio: 1 })
    await expect(page.locator('[data-aoi="video_controls"]')).toBeInViewport({ ratio: 1 })
    await expect
      .poll(() =>
        page.locator('video[data-gaze-video]').evaluate((el: HTMLVideoElement) => el.videoWidth),
      )
      .toBe(320)
    const latest = () =>
      data.recordings
        .filter((r) => r.kind === 'case_video' && !r.completed)
        .slice(-1)[0]
        ?.layouts.slice(-1)[0]
    await expect.poll(() => latest()?.aois?.some((a) => a.id === 'video_students')).toBe(true)
    await expect.poll(() => latest()?.aois?.some((a) => a.id === 'video_code')).toBe(true)
    await expect.poll(() => latest()?.frame?.w).toBe(320)
    await expect(page.locator('.unsent')).toHaveCount(0)
    await expect.poll(() => latest()?.aois?.some((a) => a.id === 'unsent_notice')).toBe(false)
    await redOverlay(page, await settledGeometry(page, latest), info, 'case')
    const buttons = await page.locator('.rail-actions [data-aoi]').evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom }
      }),
    )
    expect(buttons).toHaveLength(3)
    for (let i = 1; i < buttons.length; i++) {
      expect(buttons[i].top - buttons[i - 1].bottom).toBeGreaterThanOrEqual(16)
    }
    const layout = latest()!
    const areas = ['task_button', 'info_button', 'student_task_button'].map((id) =>
      layout.aois!.find((area) => area.id === id)!,
    )
    for (let i = 1; i < areas.length; i++) {
      const previousBottom = areas[i - 1].y + areas[i - 1].h
      expect(areas[i].y - previousBottom).toBeGreaterThanOrEqual(12)
      const x = areas[i].x + areas[i].w / 2
      const y = (previousBottom + areas[i].y) / 2
      expect(
        layout.aois!.some(
          (area) => x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h,
        ),
      ).toBe(false)
    }
    await page.getByRole('button', { name: 'Aufgabenstellung', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Aufgabenstellung', exact: true })).toContainText(
      'Sie sehen hier ein Video einer Unterrichtssituation.',
    )
    await expect
      .poll(() => latest()?.aois?.map((a) => a.id))
      .toEqual(['task_dialog', 'task_dialog_close', 'task_dialog_text'])
    await redOverlay(page, await settledGeometry(page, latest), info, 'instructions')
    await page.keyboard.press('Escape')
    await expect.poll(() => latest()?.active_modal).toBe(null)
    await expect
      .poll(() => data.events.some((event) => event.event_type === 'task_closed'))
      .toBe(true)
    const closed = data.events.find((event) => event.event_type === 'task_closed')!
    expect(closed.payload.durationMs).toBeGreaterThan(0)
    await page.locator('[data-aoi="student_task_button"]').click()
    await expect.poll(() => latest()?.active_modal).toBe('student_task_dialog')
    // Successfully delivered background events keep the modal unobstructed.
    await expect(page.locator('.unsent')).toHaveCount(0)
    await expect
      .poll(() => latest()?.aois?.map((a) => a.id))
      .toEqual(['student_task_dialog', 'student_task_dialog_close', 'student_task_dialog_text'])
    await redOverlay(page, await settledGeometry(page, latest), info, 'student-task')
    expect(
      await page
        .locator('.modal [data-line]')
        .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-line')))),
    ).toEqual([1, 2, 3, 4])
    await expect(page.locator('.modal .code')).toHaveCount(2)
    await expect(page.locator('.modal .tok--kw').first()).toHaveText('int')
    expect(await page.locator('.modal .code').allTextContents()).toEqual([
      'int a = 1;\nint b = 2;\n',
      'int c = a + b;\nSystem.out.println(c);\n',
    ])
    await page.getByRole('button', { name: 'Schließen' }).click()
    await expect.poll(() => latest()?.active_modal).toBe(null)
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect.poll(() => latest()?.window.inner_w).toBe(1280)
    await expect(page.locator('.unsent')).toHaveCount(0)
    await expect.poll(() => latest()?.aois?.some((a) => a.id === 'unsent_notice')).toBe(false)
    await redOverlay(page, await settledGeometry(page, latest), info, 'case-resized')
    expect(data.unexpected).toEqual([])
  })
}

test('only the video screen starts gaze capture across the full participant flow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const data = await participant(page)
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Fehler im Code' })).toBeVisible()
  expect(data.recordings).toEqual([])
  expect(data.bridgeCommands).not.toContain('start_gaze')
  expect(
    await page
      .locator('[data-line]')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-line')))),
  ).toEqual([1, 2, 3, 4])
  await page
    .getByRole('spinbutton', { name: 'Fehler in Zeilennummer: Zeilennummer 1', exact: true })
    .fill('1')
  for (let i = 2; i <= 7; i++) {
    await page
      .getByRole('button', {
        name: '+ Fehler bezieht sich noch auf eine weitere Zeile',
        exact: true,
      })
      .click()
    const input = page.getByRole('spinbutton', {
      name: `Fehler in Zeilennummer: Zeilennummer ${i}`,
      exact: true,
    })
    await expect(input).toBeFocused()
    await input.fill(String(((i - 1) % 4) + 1))
  }
  await expect(page.getByRole('spinbutton', { name: /Fehler in Zeilennummer:/ })).toHaveCount(7)
  await page.locator('[data-aoi="question.extra_7.answer"]').scrollIntoViewIfNeeded()
  expect(data.recordings).toEqual([])
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Fall starten' })).toBeVisible()
  expect(data.recordings).toEqual([])
  expect(data.bridgeCommands).not.toContain('start_gaze')
  expect(data.answers[0].answers).toMatchObject({ lines: [1, 2, 3, 4, 1, 2, 3] })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.locator('video[data-gaze-video]')).toBeVisible()
  await expect.poll(() => data.recordings.some((r) => r.kind === 'case_video')).toBe(true)
  await page.locator('[data-aoi="continue"]').click()
  await page
    .getByRole('dialog', { name: 'Fall abschließen?' })
    .getByRole('button', { name: 'Zur Diagnose' })
    .click()
  await expect(page.locator('[data-aoi="diagnosis_answer"]')).toBeVisible()
  await expect.poll(() => data.recordings.every((r) => r.completed)).toBe(true)
  expect(data.recordings.map((r) => r.kind)).toEqual(['case_video'])
  await page.locator('#diagnosis-text').fill('Der Fehler betrifft die Variable.')
  await page.locator('[data-aoi="continue"]').click()
  await expect(page.getByRole('heading', { name: 'Fall abgeschlossen' })).toBeVisible()
  expect(data.recordings.map((r) => r.kind)).toEqual(['case_video'])
  await page.locator('[data-aoi="continue"]').click()
  await expect.poll(() => data.recordings.every((r) => r.completed)).toBe(true)
  expect(data.recordings.map((r) => r.kind)).toEqual(['case_video'])
  expect(data.recordings[0].samples.length).toBeGreaterThan(0)
  expect(data.bridgeCommands.filter((command) => command === 'start_gaze')).toHaveLength(1)
  expect(data.unexpected).toEqual([])
})

test('confirmed case exit survives a failed session refresh', async ({ page }) => {
  const data = await participant(page, 2)
  await page.goto('/session')
  await expect(page.locator('video[data-gaze-video]')).toBeVisible()
  await page.locator('[data-aoi="notes"] textarea').fill('Notiz vor dem Seitenwechsel')
  let failedRefreshes = 0
  await page.route(`${API}/participant/session`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    failedRefreshes++
    await route.fulfill({
      status: 503,
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: { detail: 'Synthetic session refresh failure' },
    })
  })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Fall abschließen?' })
    .getByRole('button', { name: 'Zur Diagnose' })
    .click()
  await expect(page.locator('[data-aoi="diagnosis_answer"]')).toBeVisible()
  // Let the real QueryClient exhaust its refresh retry. The acknowledged
  // pointer must still render the next screen instead of a fatal query error.
  await expect.poll(() => failedRefreshes).toBe(2)
  await page.locator('#diagnosis-text').fill('Die bestätigte Navigation bleibt benutzbar.')
  await page.locator('[data-aoi="continue"]').click()
  await expect(page.getByRole('heading', { name: 'Fall abgeschlossen' })).toBeVisible()
  expect(data.recordings.every((r) => r.kind === 'case_video')).toBe(true)
  await expect(page.getByRole('dialog', { name: 'Fall abschließen?' })).not.toBeVisible()
  expect(data.unexpected).toEqual([])
})

test('questionnaire code numbering continues across questions and survives answer changes', async ({
  page,
}) => {
  const questionnaire: SessionStep = {
    index: 0,
    completed: false,
    kind: 'questionnaire',
    questionnaire_id: 41,
    placement: 'pre_test',
    title: 'Ein Programm in zwei Fragen',
    description: 'Die zweite Frage setzt das Programm der ersten fort.',
    section: 'Debugging',
    video_id: null,
    page: 1,
    page_count: 1,
    questions: [
      {
        id: 'first_snippet',
        type: 'free_text',
        text: 'Was geschieht im ersten Teil?',
        code: 'int a = 1;\nint b = 2;',
      },
      {
        id: 'second_snippet',
        type: 'free_text',
        text: 'Was geschieht danach?',
        code: ['int c = a + b;', 'System.out.println(c);'],
      },
    ],
  }
  const data = await participant(page, 0, false, [questionnaire])
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: questionnaire.title })).toBeVisible()
  const first = page.locator('[data-aoi="question.first_snippet.code"] [data-line]')
  const second = page.locator('[data-aoi="question.second_snippet.code"] [data-line]')
  const assertNumbering = async () => {
    await expect(first).toHaveCount(2)
    await expect(second).toHaveCount(2)
    expect(await first.evaluateAll((els) => els.map((el) => el.getAttribute('data-line')))).toEqual(
      ['1', '2'],
    )
    expect(
      await second.evaluateAll((els) => els.map((el) => el.getAttribute('data-line'))),
    ).toEqual(['3', '4'])
  }
  await assertNumbering()
  await page.locator('[data-aoi="question.first_snippet.answer"] textarea').fill('Zeile 2')
  await assertNumbering()
  await page.locator('[data-aoi="question.second_snippet.answer"] textarea').fill('Zeile 4')
  await assertNumbering()
  expect(data.unexpected).toEqual([])
})

test('stacked matrix answers remain visible without starting gaze capture', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 720 })
  const data = await participant(page)
  await page.goto('/session')
  const matrix = page.locator('.matrix')
  await matrix.scrollIntoViewIfNeeded()
  await expect(matrix).toHaveClass(/matrix--stacked/)
  await expectNoHorizontalOverflow(page)
  const answer = page.locator('input[name="matrix_0"]').last()
  await answer.check()
  await expect(answer).toBeChecked()
  expect(data.recordings).toEqual([])
  expect(data.bridgeCommands).not.toContain('start_gaze')
  expect(
    await matrix.locator('.matrix__scroll').evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1)
  expect(data.unexpected).toEqual([])
})

const responsiveQuestionnaire: SessionStep = {
  index: 0,
  completed: false,
  kind: 'questionnaire',
  questionnaire_id: 55,
  placement: 'pre_test',
  title: 'Lernen beim Programmieren',
  section: 'MSK',
  description:
    'Stellen Sie sich vor, Sie arbeiten an einer Programmieraufgabe und stoßen auf ein Problem. Wie beurteilen Sie die folgenden Vorgehensweisen?',
  video_id: null,
  page: 1,
  page_count: 1,
  questions: [
    ...[
      'Sie durchsuchen die wichtigen Internetseiten, um einen Überblick zu gewinnen, welche für die Aufgabe hilfreich sind.',
      'Sie sammeln möglichst viele Informationen von den verschiedenen Seiten und überfliegen diese dann, um nichts Wichtiges zu übersehen.',
    ].map((text, index) => ({
      id: `situation_${index}`,
      type: 'multiple_choice' as const,
      matrix: 'situation',
      text,
      options: [
        'sehr geeignete',
        'geeignete',
        'eher geeignete',
        'eher ungeeignete',
        'ungeeignete',
        'sehr ungeeignete',
      ].map((label, index) => ({
        value: index + 1,
        label: `${label} Handlungsmöglichkeit für diese Situation`,
      })),
    })),
    {
      id: 'many_options',
      type: 'multiple_choice',
      matrix: 'many',
      text: 'Welche Beschreibung trifft am besten auf Ihr Vorgehen zu?',
      options: Array.from({ length: 10 }, (_, i) => ({
        value: i + 1,
        label: `Ausführliche Beschreibung der Handlungsmöglichkeit ${i + 1}`,
      })),
    },
    { id: 'confidence', type: 'likert', text: 'Wie sicher sind Sie?', scale_min: 1, scale_max: 10 },
    {
      id: 'estimate',
      type: 'slider',
      text: 'Wie hoch ist der Aufwand?',
      min: 0,
      max: 100,
      required: false,
    },
    {
      id: 'ranking',
      type: 'ranking',
      text: 'Bringen Sie die Vorgehensweisen in eine Reihenfolge.',
      options: [
        'Informationen und Zusammenhänge gründlich analysieren',
        'Lösungsmöglichkeiten kritisch überprüfen',
        'Die Lösung selbstständig implementieren',
      ],
      required: false,
    },
  ],
}

for (const width of [320, 768, 1280, 1470, 1920]) {
  test(`all questionnaire choices stay reachable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    const data = await participant(page, 0, false, [
      responsiveQuestionnaire,
      { index: 1, completed: false, kind: 'thanks' },
    ])
    await page.goto('/session')
    await expect(page.getByRole('heading', { name: responsiveQuestionnaire.title })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    // The welcome page owns connection/settings guidance; tasks stay clear.
    await expect(
      page.locator(
        '[data-aoi="gaze_health"], [data-aoi="display_check_notice"], .display-check__section',
      ),
    ).toHaveCount(0)
    expect(data.recordings).toEqual([])
    expect(data.bridgeCommands).not.toContain('start_gaze')
    for (const [name, count] of [
      ['situation_0', 6],
      ['situation_1', 6],
      ['many_options', 10],
      ['confidence', 10],
    ] as const) {
      const choices = page.locator(`input[name="${name}"]`)
      await expect(choices).toHaveCount(count)
      for (const choice of await choices.all()) {
        await choice.check()
        await expect(choice).toBeChecked()
        const box = await choice.boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      }
    }
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: info.outputPath(`questionnaire-${width}.png`), fullPage: true })
    await page.locator('[data-aoi="continue"]').click()
    await expect.poll(() => data.answers.length).toBe(1)
    expect(data.answers[0].answers).toMatchObject({
      situation_0: 6,
      situation_1: 6,
      many_options: 10,
      confidence: 10,
    })
    expect(data.unexpected).toEqual([])
  })
}

for (const width of [375, 768, 1470]) {
  test(`participant screens fit the window at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    const sessionSteps: SessionStep[] = [
      { index: 0, completed: false, kind: 'welcome' },
      {
        index: 1,
        completed: false,
        kind: 'sosci',
        variant: 'pretest',
        url: 'https://example.invalid/survey',
        id_param: 'id',
        participant_id: 'TEST-UI',
      },
      { index: 2, completed: false, kind: 'calibration' },
      {
        index: 3,
        completed: false,
        kind: 'phase_transition',
        phase_type: 'training',
        phase_number: 2,
      },
      {
        index: 4,
        completed: false,
        kind: 'section_intro',
        section_key: 'pck',
        title: 'Pädagogische Entscheidungen',
        body: 'Lesen Sie die folgende Unterrichtssituation und bearbeiten Sie die Aufgaben.',
        time_limit_seconds: null,
      },
      ...steps.filter((step) => step.kind !== 'questionnaire' && step.kind !== 'thanks'),
      {
        index: 9,
        completed: false,
        kind: 'think_aloud',
        video_id: 7,
        title: 'Rückblick',
        phase_type: 'training',
        case_number: 1,
        case_total: 3,
        batch_position: 1,
        batch_size: 1,
      },
      { index: 10, completed: false, kind: 'thanks' },
    ].map((step, index) => ({ ...step, index }))
    const data = await participant(page, 0, false, sessionSteps)
    for (const step of sessionSteps) {
      data.setStep(step.index)
      await page.goto('/session')
      await expect(page.locator('.panel, .case-screen, .think-aloud').first()).toBeVisible()
      for (const fullpage of await page.locator('.fullpage').all()) {
        expect(
          await fullpage.evaluate((element) => element.getBoundingClientRect().height),
        ).toBeGreaterThanOrEqual(900)
      }
      await expectNoHorizontalOverflow(page)
      if (step.kind === 'case_video' && width >= 1000) {
        await expect(page.locator('[data-aoi="continue"]')).toBeInViewport({ ratio: 1 })
        await expect(page.locator('[data-aoi="video_controls"]')).toBeInViewport({ ratio: 1 })
      }
      await page.screenshot({ path: info.outputPath(`${step.kind}-${width}.png`), fullPage: true })
    }
    expect(data.unexpected).toEqual([])
  })
  test(`login pages fit the window at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    for (const path of ['/login', '/admin/login']) {
      await page.goto(path)
      await expect(page.locator('form')).toBeVisible()
      await expectNoHorizontalOverflow(page)
    }
  })
}

test('laptop fallback encodes and uploads a screen stream while gaze continues', async ({
  page,
}, info) => {
  // Substitute only the consented display stream. The browser's real MediaRecorder
  // encodes the frames; the OS picker/permissions still require a manual check.
  await page.addInitScript(() => {
    let frames = 0
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 640
        canvas.height = 360
        const context = canvas.getContext('2d')!
        const paint = () => {
          context.fillStyle = frames++ % 2 ? '#244e77' : '#5684ad'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.fillStyle = '#fff'
          context.fillText(`Screen frame ${frames}`, 20, 40)
          requestAnimationFrame(paint)
        }
        paint()
        return canvas.captureStream(15)
      },
    })
  })
  const data = await participant(page, 1)
  // WebKit's intercepted postDataBuffer omits multipart file contents. Receive
  // the actual HTTP body so every engine must deliver its real encoded bytes.
  const receiver = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      data.screenUploads.push(Buffer.concat(chunks))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    receiver.once('error', reject)
    receiver.listen(0, '127.0.0.1', resolve)
  })
  const uploadUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/upload`
  let declaredSize = 0
  try {
    await page.route(`${API}/screen/recordings/99/upload-url`, (route) => {
      declaredSize = route.request().postDataJSON().size_bytes
      return route.fallback()
    })
    await page.route(`${API}/screen/recordings/99/upload`, (route) =>
      route.continue({ url: uploadUrl }),
    )
    await page.goto('/session')
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect.poll(() => data.screenStarts.some((s) => s.recorder === 'browser')).toBe(true)
    await expect.poll(() => data.recordings.some((r) => r.kind === 'case_video')).toBe(true)
    await expect
      .poll(() =>
        page.locator('video[data-gaze-video]').evaluate((el: HTMLVideoElement) => el.videoWidth),
      )
      .toBe(320)
    await page.locator('[data-aoi="notes"] textarea').fill('Notiz während der Aufnahme')
    await page.locator('[data-aoi="student_task_button"]').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Schließen' }).click()
    await page.locator('[data-aoi="continue"]').click()
    const exitDialog = page.getByRole('dialog', { name: 'Fall abschließen?' })
    await expect(exitDialog).toBeVisible()
    // Asking to leave must not stop or upload the case recording. Cancelling
    // preserves the same gaze record and participant notes.
    expect(data.screenUploads).toHaveLength(0)
    expect(data.recordings.filter((r) => r.kind === 'case_video').every((r) => !r.completed)).toBe(
      true,
    )
    await expect
      .poll(() =>
        data.recordings
          .filter((r) => r.kind === 'case_video')
          .some((r) => r.layouts.at(-1)?.aois?.some((a) => a.id === 'case_exit_dialog')),
      )
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(exitDialog).not.toBeVisible()
    await expect(page.locator('[data-aoi="notes"] textarea')).toHaveValue(
      'Notiz während der Aufnahme',
    )
    expect(data.screenUploads).toHaveLength(0)
    await page.locator('[data-aoi="continue"]').click()
    await exitDialog.getByRole('button', { name: 'Zur Diagnose' }).click()
    await expect.poll(() => data.screenUploads.length).toBe(1)
    await expect
      .poll(() =>
        data.recordings
          .filter((r) => r.kind === 'case_video')
          .some((r) => r.completed && r.samples.length > 0),
      )
      .toBe(true)
    const multipart = data.screenUploads[0]
    const fileHeader = multipart.indexOf(Buffer.from('name="file"'))
    expect(fileHeader).toBeGreaterThan(0)
    const fileStart = multipart.indexOf(Buffer.from('\r\n\r\n'), fileHeader) + 4
    const fileEnd = multipart.indexOf(Buffer.from('\r\n------'), fileStart)
    expect(fileEnd - fileStart).toBeGreaterThan(500)
    const recording = multipart.subarray(fileStart, fileEnd)
    expect(recording.length).toBe(declaredSize)
    const mp4 = recording.subarray(4, 8).toString() === 'ftyp'
    // Browsers may encode WebM or MP4 depending on codec support.
    expect(mp4 || recording.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true)
    await writeFile(info.outputPath(`screen-capture.${mp4 ? 'mp4' : 'webm'}`), recording)
    expect(multipart.toString('latin1')).toContain('name="epoch_ms"')
    expect(multipart.toString('latin1')).toContain('name="duration_ms"')
    expect(data.unexpected).toEqual([])
  } finally {
    await new Promise<void>((resolve, reject) => {
      receiver.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

const longPageText = Array.from(
  { length: 18 },
  (_, index) =>
    `Abschnitt ${index + 1}: Lesen Sie die ausführlichen Informationen aufmerksam durch und berücksichtigen Sie alle Hinweise bei Ihrer Antwort.`,
).join('\n\n')

function scrollQuestionnaire(index: number): SessionStep {
  return {
    index,
    completed: false,
    kind: 'questionnaire',
    questionnaire_id: 810 + index,
    placement: 'pre_test',
    title: `Fragebogenseite ${index + 1}`,
    description: longPageText,
    section: 'Navigation',
    video_id: null,
    page: index + 1,
    page_count: 4,
    questions: [{ id: `note_${index}`, type: 'free_text', text: 'Ihre Notiz', required: false }],
  }
}

test('Weiter starts every committed session page at the top', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const sessionSteps: SessionStep[] = [
    scrollQuestionnaire(0),
    scrollQuestionnaire(1),
    {
      index: 2,
      completed: false,
      kind: 'section_intro',
      section_key: 'pck',
      title: 'Einleitung zum nächsten Abschnitt',
      body: longPageText,
      time_limit_seconds: null,
    },
    scrollQuestionnaire(3),
  ]
  const data = await participant(page, 0, false, sessionSteps)
  await page.goto('/session')
  for (let index = 0; index < sessionSteps.length - 1; index++) {
    const current = sessionSteps[index]
    const next = sessionSteps[index + 1]
    if (!('title' in current) || !('title' in next)) throw new Error('Expected titled test pages')
    await expect(page.getByRole('heading', { name: current.title, exact: true })).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300)
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: next.title, exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  }
  expect(data.answers).toHaveLength(2)
  expect(data.unexpected).toEqual([])
})

test('failed questionnaire submission keeps the reading position and answer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const data = await participant(page, 0, false, [scrollQuestionnaire(0), scrollQuestionnaire(1)])
  let failures = 0
  await page.route(`${API}/participant/questionnaires/810/respond`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    failures++
    return route.fulfill({
      status: 500,
      json: { detail: 'Synthetic save failure' },
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  })
  await page.goto('/session')
  const answer = page.locator('[data-aoi="question.note_0.answer"] textarea')
  await answer.fill('Diese Antwort bleibt bei einem Fehler erhalten.')
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const before = await page.evaluate(() => window.scrollY)
  expect(before).toBeGreaterThan(300)
  const next = page.getByRole('button', { name: 'Weiter', exact: true })
  await next.click()
  await expect.poll(() => failures).toBe(3)
  await expect(next).toBeEnabled()
  await expect(answer).toHaveValue('Diese Antwort bleibt bei einem Fehler erhalten.')
  await expect(page.getByRole('heading', { name: 'Fragebogenseite 2', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(before, 0)
  expect(data.answers).toHaveLength(0)
  expect(data.unexpected).toEqual([])
})
