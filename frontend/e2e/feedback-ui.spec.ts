import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

import type { SessionStep } from '../src/api/participant'
import type { GazeLayout } from '../src/lib/gazeGeometry'

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
      if (request.type === 'start_gaze') {
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
    if (
      path === '/participant/events' ||
      path === '/participant/notes' ||
      path === '/participant/diagnosis'
    )
      return json({ id: 1 })
    if (path.endsWith('/notes')) return json([])
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
  return { recordings, answers, screenStarts, screenUploads, unexpected }
}

async function verifyBounds(page: Page, geometry: GazeLayout) {
  const expected = await page.locator('[data-aoi]').evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        id: el.getAttribute('data-aoi'),
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        right: Math.min(innerWidth, rect.right),
        bottom: Math.min(innerHeight, rect.bottom),
      }
    }),
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
    const data = await participant(page, 2)
    await page.goto('/session')
    await expect(page.locator('video[data-gaze-video]')).toBeVisible()
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
    await expect.poll(() => latest()?.aois?.some((a) => a.id === 'video')).toBe(true)
    await expect.poll(() => latest()?.frame?.w).toBe(320)
    await expect(page.locator('.unsent')).toHaveCount(0)
    await expect.poll(() => latest()?.aois?.some((a) => a.id === 'unsent_notice')).toBe(false)
    await redOverlay(page, await settledGeometry(page, latest), info, 'case')
    await page.locator('[data-aoi="student_task_button"]').click()
    await expect.poll(() => latest()?.active_modal).toBe('student_task_dialog')
    // Opening the modal logs an event. Its successfully delivered outbox job
    // briefly renders a real notice above the modal until acknowledgement.
    await expect(page.locator('.unsent')).toHaveCount(0)
    await expect.poll(() => latest()?.aois?.map((a) => a.id)).toEqual(['student_task_dialog'])
    await redOverlay(page, await settledGeometry(page, latest), info, 'student-task')
    expect(
      await page
        .locator('.modal [data-line]')
        .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-line')))),
    ).toEqual([1, 2, 3, 4])
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

test('questionnaire AOIs follow scrolling and repeated fields; all measured steps have contexts', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const data = await participant(page)
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Fehler im Code' })).toBeVisible()
  const latest = () =>
    data.recordings
      .filter((r) => r.kind === 'questionnaire' && !r.completed)
      .slice(-1)[0]
      ?.layouts.slice(-1)[0]
  await expect.poll(() => latest()?.aois?.some((a) => a.id === 'instructions')).toBe(true)
  await redOverlay(page, await settledGeometry(page, latest), info, 'questionnaire')
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
  await expect.poll(() => latest()?.aois?.some((a) => a.id === 'question.lines.answer')).toBe(true)
  await redOverlay(page, latest()!, info, 'line-fields')
  await page.locator('[data-aoi="question.extra_7.answer"]').scrollIntoViewIfNeeded()
  await expect
    .poll(() => latest()?.aois?.some((a) => a.id === 'question.extra_7.answer'))
    .toBe(true)
  expect(latest()!.aois!.some((a) => a.id === 'page_title')).toBe(false)
  await redOverlay(page, await settledGeometry(page, latest), info, 'questionnaire-scrolled')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Fall starten' })).toBeVisible()
  expect(data.answers[0].answers).toMatchObject({ lines: [1, 2, 3, 4, 1, 2, 3] })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.locator('video[data-gaze-video]')).toBeVisible()
  await expect.poll(() => data.recordings.some((r) => r.kind === 'case_video')).toBe(true)
  await page.locator('[data-aoi="continue"]').click()
  await expect(page.locator('[data-aoi="diagnosis_answer"]')).toBeVisible()
  await expect.poll(() => data.recordings.some((r) => r.kind === 'diagnosis')).toBe(true)
  await page.locator('#diagnosis-text').fill('Der Fehler betrifft die Variable.')
  await page.locator('[data-aoi="continue"]').click()
  await expect.poll(() => data.recordings.some((r) => r.kind === 'case_outro')).toBe(true)
  await page.locator('[data-aoi="continue"]').click()
  await expect.poll(() => data.recordings.every((r) => r.completed)).toBe(true)
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

test('matrix AOIs exclude answers covered by the sticky question column', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 400, height: 720 })
  const data = await participant(page)
  await page.goto('/session')
  const scroll = page.locator('.matrix__scroll')
  await scroll.scrollIntoViewIfNeeded()
  const latest = () =>
    data.recordings
      .filter((r) => r.kind === 'questionnaire' && !r.completed)
      .slice(-1)[0]
      ?.layouts.slice(-1)[0]
  await expect
    .poll(() => latest()?.aois?.some((a) => a.id === 'question.matrix_0.prompt'))
    .toBe(true)
  const before = latest()!.aois!.find((a) => a.id === 'question.matrix_0.prompt')!
  await scroll.evaluate((el) => {
    el.scrollLeft = el.scrollWidth - el.clientWidth
  })
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  const prompt = await page.locator('[data-aoi="question.matrix_0.prompt"]').boundingBox()
  await expect
    .poll(() =>
      latest()
        ?.aois?.filter((a) => a.id === 'question.matrix_0.answer')
        .every((a) => a.x >= prompt!.x + prompt!.width - 0.5),
    )
    .toBe(true)
  const layout = latest()!
  expect(layout.aois!.find((a) => a.id === 'question.matrix_0.prompt')!.x).toBeCloseTo(before.x, 0)
  expect(layout.aois!.filter((a) => a.id === 'question.matrix_0.answer').length).toBeGreaterThan(0)
  await redOverlay(page, layout, info, 'matrix-scrolled')
  expect(data.unexpected).toEqual([])
})

test('laptop fallback encodes and uploads a screen stream while gaze continues', async ({
  page,
}, info) => {
  // Substitute only the consented display stream. Chromium's real MediaRecorder
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
  await expect.poll(() => data.screenUploads.length).toBe(1)
  await expect
    .poll(() =>
      data.recordings
        .filter((r) => r.kind === 'case_video')
        .some((r) => r.completed && r.samples.length > 0),
    )
    .toBe(true)
  const multipart = data.screenUploads[0]
  const fileStart = multipart.indexOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  expect(fileStart).toBeGreaterThan(0)
  const fileEnd = multipart.indexOf(Buffer.from('\r\n------'), fileStart)
  expect(fileEnd - fileStart).toBeGreaterThan(500)
  await writeFile(info.outputPath('screen-capture.webm'), multipart.subarray(fileStart, fileEnd))
  expect(multipart.toString('latin1')).toContain('name="epoch_ms"')
  expect(multipart.toString('latin1')).toContain('name="duration_ms"')
  expect(data.unexpected).toEqual([])
})
