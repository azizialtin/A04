import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { gazeApi, type GazeContext } from '../api/gaze'
import type { GazeLayout } from '../lib/gazeGeometry'
import { useGazeCapture } from './useGazeCapture'

vi.mock('../api/gaze', () => ({
  gazeApi: {
    startRecording: vi.fn(),
    uploadSamples: vi.fn(),
    addGeometry: vi.fn(),
    completeRecording: vi.fn(),
  },
}))

let layout: GazeLayout
const observers = new Set<() => void>()
vi.mock('../lib/aoi', () => ({
  capturePageGeometry: () => ({ ...layout, ts: Date.now() }),
  observePageGeometry: (callback: () => void) => {
    observers.add(callback)
    return () => observers.delete(callback)
  },
}))

const start = vi.mocked(gazeApi.startRecording)
const upload = vi.mocked(gazeApi.uploadSamples)
const geometry = vi.mocked(gazeApi.addGeometry)
const complete = vi.mocked(gazeApi.completeRecording)
const caseContext: GazeContext = { video_id: 8, step_kind: 'case_video', step_index: 12 }

class FakeSocket {
  static readonly OPEN = 1
  static all: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  sent: unknown[] = []
  closed = false

  constructor() {
    FakeSocket.all.push(this)
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }

  close() {
    this.closed = true
  }

  say(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function connect(socket = FakeSocket.all[FakeSocket.all.length - 1]) {
  await act(async () => socket.say({ type: 'status', connected: true, frequency: 90 }))
  return socket
}

function samples(socket: FakeSocket, count: number, first = 1) {
  for (let i = 0; i < count; i++) {
    socket.say({ type: 'gaze', ts: first + i, lx: 0.3, ly: 0.4, lv: true, rv: false })
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  })
  vi.setSystemTime(100_000)
  FakeSocket.all = []
  observers.clear()
  vi.stubGlobal('WebSocket', FakeSocket)
  start.mockReset().mockResolvedValue({ recording_id: 7 })
  upload.mockReset().mockResolvedValue({} as never)
  geometry.mockReset().mockResolvedValue({} as never)
  complete.mockReset().mockResolvedValue({} as never)
  layout = {
    ts: Date.now(),
    screen: { w: 1920, h: 1080 },
    window: { x: 0, y: 0, outer_w: 1920, outer_h: 1080, inner_w: 1920, inner_h: 980 },
    dpr: 1,
    aois: [{ id: 'question:one', x: 10, y: 10, w: 100, h: 50, priority: 1 }],
    active_modal: null,
    visible: true,
  }
})

afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test.each<GazeContext>([
  caseContext,
  { video_id: null, step_kind: 'questionnaire', step_index: 2, questionnaire_id: 14 },
  { video_id: 8, step_kind: 'diagnosis', step_index: 13 },
])('records screen identity and the tracker rate for $step_kind', async (context) => {
  const { unmount } = renderHook(() => useGazeCapture(context))
  const socket = await connect()
  expect(start).toHaveBeenCalledWith({
    ...context,
    questionnaire_id: context.questionnaire_id ?? null,
    sampling_rate_hz: 90,
    geometry: expect.objectContaining({ aois: layout.aois, ts: 100_000 }),
  })
  expect(socket.sent).toContainEqual({ type: 'start_gaze' })
  unmount()
  await act(async () => {})
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 0 })
})

test('a backlog above the API cap retries in ordered batches of at most 500 samples', async () => {
  upload.mockRejectedValueOnce(new Error('offline'))
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  await act(async () => samples(socket, 1201))
  expect(upload).toHaveBeenCalledTimes(1)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(upload.mock.calls.map(([, batch]) => batch.length)).toEqual([500, 500, 500, 201])
  expect(upload.mock.calls.map(([, , offset]) => offset)).toEqual([0, 0, 500, 1000])
  expect(
    upload.mock.calls.slice(1).flatMap(([, batch]) => batch.map((sample) => sample.ts)),
  ).toEqual(Array.from({ length: 1201 }, (_, i) => i + 1))
  unmount()
  await act(async () => {})
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 1201 })
})

test('a lost acknowledgement resends the same chunk and advances offset only after confirmation', async () => {
  const accepted = new Map<number, unknown>()
  let loseResponse = true
  upload.mockImplementation(async (_id, batch, offset) => {
    expect(offset).toBeDefined()
    const previous = accepted.get(offset!)
    if (previous) expect(batch).toEqual(previous)
    else accepted.set(offset!, structuredClone(batch))
    if (loseResponse) {
      loseResponse = false
      throw new Error('response lost after the server committed')
    }
    return {} as never
  })
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  await act(async () => samples(socket, 501))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  unmount()
  await act(async () => {})

  expect(upload.mock.calls.map(([, , offset]) => offset)).toEqual([0, 0, 500])
  expect(upload.mock.calls[1][1]).toBe(upload.mock.calls[0][1])
  expect(accepted.size).toBe(2)
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 501 })
})

test('overflow drops only newer queued samples and cannot alter an uncertain retry batch', async () => {
  upload.mockRejectedValueOnce(new Error('response lost'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  await act(async () => samples(socket, 500))
  const original = structuredClone(upload.mock.calls[0][1])
  await act(async () => samples(socket, 16_000, 501))
  expect(upload).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  unmount()
  await act(async () => {})

  expect(upload.mock.calls[1]).toEqual([7, original, 0])
  expect(upload.mock.calls[2][2]).toBe(500)
  expect(upload.mock.calls[2][1][0].ts).toBe(1501)
  expect(upload.mock.calls.slice(1).reduce((sum, [, batch]) => sum + batch.length, 0)).toBe(15_500)
  expect(upload.mock.calls.every(([, batch]) => batch.length <= 500)).toBe(true)
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 15_500 })
})

test('a slow previous screen upload cannot consume or finalize the next screen recording', async () => {
  const oldUpload = deferred<never>()
  start.mockResolvedValueOnce({ recording_id: 7 }).mockResolvedValueOnce({ recording_id: 8 })
  upload.mockReturnValueOnce(oldUpload.promise)
  const { rerender, unmount } = renderHook(({ context }) => useGazeCapture(context), {
    initialProps: { context: caseContext },
  })
  const oldSocket = await connect()
  await act(async () => samples(oldSocket, 502))
  rerender({ context: { video_id: 8, step_kind: 'diagnosis', step_index: 13 } })
  const newSocket = await connect()
  samples(oldSocket, 1, 9999)
  samples(newSocket, 3, 2001)
  expect(oldSocket.closed).toBe(true)
  expect(observers.size).toBe(1)
  expect(complete).not.toHaveBeenCalled()

  await act(async () => oldUpload.resolve({} as never))
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 502 })
  expect(complete).not.toHaveBeenCalledWith(8, expect.anything())
  unmount()
  await act(async () => {})
  expect(complete).toHaveBeenCalledWith(8, { sample_count: 3 })
  expect(
    upload.mock.calls.filter(([id]) => id === 7).flatMap(([, batch]) => batch.map((s) => s.ts)),
  ).toEqual(Array.from({ length: 502 }, (_, i) => i + 1))
  expect(
    upload.mock.calls.filter(([id]) => id === 8).flatMap(([, batch]) => batch.map((s) => s.ts)),
  ).toEqual([2001, 2002, 2003])
})

test('failed geometry retains its original timestamp and is retried before finalization', async () => {
  geometry.mockRejectedValueOnce(new Error('offline'))
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  await connect()
  vi.setSystemTime(100_250)
  layout = { ...layout, active_modal: 'student_task', aois: [] }
  await act(async () => observers.forEach((notify) => notify()))
  expect(geometry).toHaveBeenCalledTimes(1)
  vi.setSystemTime(101_500)
  unmount()
  await act(async () => {})
  expect(geometry).toHaveBeenCalledTimes(2)
  expect(geometry.mock.calls[0]).toEqual(geometry.mock.calls[1])
  expect(geometry.mock.calls[1][1]).toMatchObject({ ts: 100_250, active_modal: 'student_task' })
  expect(geometry.mock.invocationCallOrder[1]).toBeLessThan(complete.mock.invocationCallOrder[0])
})

test('unchanged layout notifications never upload geometry just because time passed', async () => {
  renderHook(() => useGazeCapture(caseContext))
  await connect()
  for (let frame = 1; frame <= 60; frame++) {
    vi.setSystemTime(100_000 + frame * 16)
    observers.forEach((notify) => notify())
  }
  await act(async () => {})
  expect(geometry).not.toHaveBeenCalled()
})

test('samples reference a failed layout instead of inheriting the last stored geometry', async () => {
  geometry.mockRejectedValue(new Error('geometry unavailable'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_250)
  layout = { ...layout, active_modal: 'student_task', aois: [] }
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100_300)
  unmount()
  await act(async () => {})

  expect(start.mock.calls[0][0].geometry?.ts).toBe(100_000)
  expect(upload.mock.calls[0][1][0]).toMatchObject({ ts: 100_300, geometry_ts: 100_250 })
  expect(geometry.mock.calls.every(([, snapshot]) => snapshot.ts === 100_250)).toBe(true)
  expect(warning).toHaveBeenCalled()
})

test('delayed samples use their historical layout and never a snapshot from their future', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_250)
  layout = { ...layout, active_modal: 'student_task', aois: [] }
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100_300)
  samples(socket, 1, 100_100)
  samples(socket, 1, 99_999)
  unmount()
  await act(async () => {})
  expect(upload.mock.calls[0][1].map(({ ts, geometry_ts }) => ({ ts, geometry_ts }))).toEqual([
    { ts: 100_300, geometry_ts: 100_250 },
    { ts: 100_100, geometry_ts: 100_000 },
    { ts: 99_999, geometry_ts: null },
  ])
})

test('same-millisecond changes stay ambiguous until a later stable measurement', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  layout = { ...layout, active_modal: 'student_task', aois: [] }
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100_000)
  vi.setSystemTime(100_010)
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100_011)
  unmount()
  await act(async () => {})

  expect(geometry.mock.calls.map(([, snapshot]) => snapshot.ts)).toEqual([100_000, 100_010])
  expect(upload.mock.calls[0][1].map(({ geometry_ts }) => geometry_ts)).toEqual([null, 100_010])
})

test('rapid layout changes do not hammer a failed geometry endpoint during backoff', async () => {
  geometry.mockRejectedValueOnce(new Error('offline'))
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  await connect()
  vi.setSystemTime(100_010)
  layout = { ...layout, active_modal: 'student_task' }
  await act(async () => observers.forEach((notify) => notify()))
  for (let i = 0; i < 10; i++) {
    vi.setSystemTime(100_020 + i)
    layout = { ...layout, active_modal: `dialog-${i}` }
    await act(async () => observers.forEach((notify) => notify()))
  }
  expect(geometry).toHaveBeenCalledTimes(1)
  // Final cleanup bypasses the retry clock and retains every transition's timestamp.
  unmount()
  await act(async () => {})
  expect(geometry).toHaveBeenCalledTimes(12)
  expect(geometry.mock.calls[1][1].ts).toBe(100_010)
  expect(geometry.mock.calls[11][1].ts).toBe(100_029)
})

test('clock rollback makes subsequent references uncertain instead of selecting old layouts', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(99_000)
  layout = { ...layout, active_modal: 'student_task' }
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 99_100)
  // Even after the clock catches up, the older timestamp could name the wrong screen.
  samples(socket, 1, 100_100)
  unmount()
  await act(async () => {})
  expect(upload.mock.calls[0][1].map(({ geometry_ts }) => geometry_ts)).toEqual([null, null])
})

test('layout exhaustion stops extending the history and never inherits the last allowed AOI', async () => {
  geometry.mockRejectedValue(new Error('offline'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  await act(async () => {
    for (let i = 1; i <= 10_005; i++) {
      vi.setSystemTime(100_000 + i)
      layout = { ...layout, active_modal: `dialog-${i}` }
      observers.forEach((notify) => notify())
    }
  })
  samples(socket, 1, 110_006)
  unmount()
  await act(async () => {})
  expect(upload.mock.calls[0][1][0].geometry_ts).toBeNull()
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('10005 layouts'))
})

test('nonboolean bridge validity flags never turn a lost eye into a valid sample', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  socket.say({ type: 'gaze', ts: 100_100, lx: 0.4, ly: 0.5, lv: 'false', rv: 1 })
  unmount()
  await act(async () => {})
  expect(upload.mock.calls[0][1][0]).toMatchObject({ lv: false, rv: false })
})

test('a recording created after its screen is gone is closed without starting gaze', async () => {
  const pending = deferred<{ recording_id: number }>()
  start.mockReturnValue(pending.promise)
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = FakeSocket.all[0]
  socket.say({ type: 'status', connected: true })
  unmount()
  await act(async () => pending.resolve({ recording_id: 9 }))
  expect(socket.sent).not.toContainEqual({ type: 'start_gaze' })
  expect(complete).toHaveBeenCalledWith(9, { sample_count: 0 })
  expect(upload).not.toHaveBeenCalled()
})

test('a missing tracker creates no recording and sends no samples or layouts', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = FakeSocket.all[0]
  socket.say({ type: 'status', connected: false, screen_recording: true })
  samples(socket, 501)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000)
  })
  unmount()
  await act(async () => {})
  expect(start).not.toHaveBeenCalled()
  expect(upload).not.toHaveBeenCalled()
  expect(geometry).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
})

test('unmeasured screens do not connect to the bridge', () => {
  renderHook(() => useGazeCapture(null))
  expect(FakeSocket.all).toHaveLength(0)
  expect(observers.size).toBe(0)
})
