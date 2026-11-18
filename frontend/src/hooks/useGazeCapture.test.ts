import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { gazeApi, type GazeContext } from '../api/gaze'
import type { GazeLayout } from '../lib/gazeGeometry'
import { useGazeCapture } from './useGazeCapture'
import { enqueue } from '../lib/outbox'
import { gazeDeliveryWarning, resetGazeDeliverySession } from '../lib/gazeDelivery'
import * as nativeMapping from '../lib/nativeViewport'
import { displayGuardAllowsSample } from '../lib/displayGuard'
vi.mock('../lib/outbox', () => ({ enqueue: vi.fn() }))

const guardListeners = new Set<() => void>()
vi.mock('../lib/displayGuard', () => ({
  displayGuardAllowsSample: vi.fn(() => true),
  getDisplayGuardSnapshot: () => ({ enabled: false }),
  subscribeDisplayGuard: (callback: () => void) => {
    guardListeners.add(callback)
    return () => guardListeners.delete(callback)
  },
}))

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
    act(() => this.onmessage?.({ data: JSON.stringify(message) }))
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

function samples(socket: FakeSocket, count: number, first = 100_001) {
  for (let i = 0; i < count; i++) {
    socket.say({ type: 'gaze', ts: first + i, lx: 0.3, ly: 0.4, lv: true, rv: false })
  }
}

function storedReferences() {
  return upload.mock.calls.flatMap(([, batch]) =>
    batch.map(({ ts, geometry_ts }) => ({ ts, geometry_ts })),
  )
}

function statusPayloads() {
  return vi.mocked(enqueue).mock.calls.map(([, body]) => body.payload as Record<string, unknown>)
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  })
  vi.setSystemTime(100_000)
  vi.mocked(enqueue).mockClear()
  resetGazeDeliverySession()
  FakeSocket.all = []
  observers.clear()
  guardListeners.clear()
  vi.mocked(displayGuardAllowsSample).mockReset().mockReturnValue(true)
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

test('display interruption retains every raw gaze sample while removing uncertain geometry references', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  expect(guardListeners.size).toBe(1)
  samples(socket, 1, 100_010)
  vi.mocked(displayGuardAllowsSample).mockReturnValue(false)
  samples(socket, 1, 100_020)
  vi.mocked(displayGuardAllowsSample).mockReturnValue(true)
  samples(socket, 1, 100_030)
  unmount()
  await act(async () => {})
  expect(start).toHaveBeenCalledTimes(1)
  expect(guardListeners.size).toBe(0)
  const saved = upload.mock.calls.flatMap(([, batch]) => batch)
  expect(saved.map((sample) => sample.ts)).toEqual([100_010, 100_020, 100_030])
  expect(saved.map((sample) => sample.geometry_ts)).toEqual([100_000, null, 100_000])
  expect(saved.every((sample) => sample.lx === 0.3 && sample.ly === 0.4 && sample.lv)).toBe(true)
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 3 })
})

test('records the video identity and tracker rate', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  expect(start).toHaveBeenCalledWith({
    ...caseContext,
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
  ).toEqual(Array.from({ length: 1201 }, (_, i) => 100_001 + i))
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
  await act(async () => samples(socket, 16_000, 100_501))
  expect(upload).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  unmount()
  await act(async () => {})

  expect(upload.mock.calls[1]).toEqual([7, original, 0])
  expect(upload.mock.calls[2][2]).toBe(500)
  expect(upload.mock.calls[2][1][0].ts).toBe(101_501)
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
  rerender({ context: { video_id: 9, step_kind: 'case_video', step_index: 20 } })
  const newSocket = await connect()
  samples(oldSocket, 1, 9999)
  samples(newSocket, 3, 120_001)
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
  ).toEqual(Array.from({ length: 502 }, (_, i) => 100_001 + i))
  expect(
    upload.mock.calls.filter(([id]) => id === 8).flatMap(([, batch]) => batch.map((s) => s.ts)),
  ).toEqual([120001, 120002, 120003])
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

test('delayed samples use their historical layout and pre-video samples are discarded', async () => {
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
  // The event log says from when, and that the finished recording is affected.
  expect(
    statusPayloads()
      .filter((status) => status.clock_uncertain)
      .map((status) => status.state),
  ).toEqual(['waiting_samples', 'tracking', 'capture_finished'])
})

test('a clock rollback before any layout notification preserves raw samples without AOI references', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(99_000)
  samples(socket, 1, 99_000)
  vi.setSystemTime(100_100)
  samples(socket, 1, 100_100)
  unmount()
  await act(async () => {})
  expect(upload.mock.calls[0][1].map(({ ts, geometry_ts }) => ({ ts, geometry_ts }))).toEqual([
    { ts: 99_000, geometry_ts: null },
    { ts: 100_100, geometry_ts: null },
  ])
})

test('a millisecond clock rollback recovers only after a fresh stable layout measurement', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_500)
  // The periodic measurement: the layout is unchanged, but this is the newest clock reading.
  await act(async () => observers.forEach((notify) => notify()))
  // A small browser clock adjustment still creates ambiguous sample timestamps.
  vi.setSystemTime(100_499)
  samples(socket, 1, 100_499)
  vi.setSystemTime(100_500)
  samples(socket, 1, 100_500)
  vi.setSystemTime(100_700)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(160_000)
  samples(socket, 1, 160_000)
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual([
    { ts: 100_499, geometry_ts: null },
    { ts: 100_500, geometry_ts: null },
    { ts: 160_000, geometry_ts: 100_700 },
  ])
  expect(statusPayloads().every((status) => status.clock_uncertain === false)).toBe(true)
  expect(geometry.mock.calls.map(([, snapshot]) => snapshot.ts)).toEqual([100_700])
})

test.each([
  [100, 'recoverable with a fresh measurement', 100_900],
  [101, 'permanently uncertain', null],
])(
  'a clock %i ms behind its highest observed reading is %s',
  async (behind, _outcome, laterReference) => {
    const { unmount } = renderHook(() => useGazeCapture(caseContext))
    const socket = await connect()
    vi.setSystemTime(100_500)
    await act(async () => observers.forEach((notify) => notify()))
    vi.setSystemTime(100_500 - behind)
    samples(socket, 1, 100_500 - behind)
    vi.setSystemTime(100_900)
    await act(async () => observers.forEach((notify) => notify()))
    vi.setSystemTime(101_000)
    samples(socket, 1, 101_001)
    unmount()
    await act(async () => {})
    expect(storedReferences()).toEqual([
      { ts: 100_500 - behind, geometry_ts: null },
      { ts: 101_001, geometry_ts: laterReference },
    ])
    expect(enqueue).toHaveBeenLastCalledWith(
      'event',
      expect.objectContaining({
        payload: expect.objectContaining({
          state: 'capture_finished',
          clock_uncertain: laterReference === null,
        }),
      }),
    )
  },
)

test('a layout change during a tolerated step is never ordered before the layout it replaced', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_500)
  layout = { ...layout, active_modal: 'task_dialog' }
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_480)
  layout = { ...layout, active_modal: null }
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_600)
  // Both changes share the newest reading: ambiguous, but never the popup that has closed.
  samples(socket, 1, 100_600)
  vi.setSystemTime(100_700)
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100_801)
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual([
    { ts: 100_600, geometry_ts: null },
    { ts: 100_801, geometry_ts: 100_700 },
  ])
  expect(geometry.mock.calls.map(([, snapshot]) => [snapshot.ts, snapshot.active_modal])).toEqual([
    [100_500, 'task_dialog'],
    [100_500, null],
    [100_700, null],
  ])
})

test('delayed rollback samples never inherit an obsolete layout after popup recovery', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_500)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_480)
  layout = { ...layout, active_modal: 'task_dialog' }
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_600)
  samples(socket, 1, 100_490)
  // Recovery requires a new measurement, not just the passage of wall-clock time.
  samples(socket, 1, 100_600)
  vi.setSystemTime(100_700)
  await act(async () => observers.forEach((notify) => notify()))
  // Includes a sample captured before rollback was first observed, and a bridge
  // timestamp beyond the browser's old high-water mark (browser-only rollback).
  for (const ts of [100_470, 100_490, 100_500, 100_501, 100_700, 100_800, 100_801]) {
    samples(socket, 1, ts)
  }
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual(
    [100_490, 100_600, 100_470, 100_490, 100_500, 100_501, 100_700, 100_800, 100_801].map((ts) => ({
      ts,
      geometry_ts: ts === 100_801 ? 100_700 : null,
    })),
  )
  expect(geometry.mock.calls.map(([, snapshot]) => [snapshot.ts, snapshot.active_modal])).toEqual([
    [100_500, 'task_dialog'],
    [100_700, 'task_dialog'],
  ])
})

test.each([1, 100])(
  'a %i ms rollback at video entry retains immediate and delayed raw samples',
  async (rollback) => {
    const { unmount } = renderHook(() => useGazeCapture(caseContext))
    const socket = await connect()
    vi.setSystemTime(100_000 - rollback)
    samples(socket, 1, 100_000 - rollback)
    vi.setSystemTime(100_200)
    await act(async () => observers.forEach((notify) => notify()))
    samples(socket, 1, 100_000 - rollback)
    samples(socket, 1, 99_899) // Older than the entire bounded entry-overlap window.
    samples(socket, 1, 100_301)
    unmount()
    await act(async () => {})
    expect(storedReferences()).toEqual([
      { ts: 100_000 - rollback, geometry_ts: null },
      { ts: 100_000 - rollback, geometry_ts: null },
      { ts: 100_301, geometry_ts: 100_200 },
    ])
    expect(complete).toHaveBeenCalledWith(7, { sample_count: 3 })
  },
)

test('a rollback first observed after recrossing video entry retains ambiguous early samples', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_010)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_005)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_200)
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 99_995)
  samples(socket, 1, 99_899)
  samples(socket, 1, 100_301)
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual([
    { ts: 99_995, geometry_ts: null },
    { ts: 100_301, geometry_ts: 100_200 },
  ])
})

test('sample receipts detect a rollback between unchanged layout measurements', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_500)
  samples(socket, 1, 100_500)
  vi.setSystemTime(100_480)
  samples(socket, 1, 100_480)
  vi.setSystemTime(100_700)
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100_490)
  samples(socket, 1, 100_801)
  samples(socket, 1, 99_999) // This late rollback did not overlap video entry.
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual([
    { ts: 100_500, geometry_ts: 100_000 },
    { ts: 100_480, geometry_ts: null },
    { ts: 100_490, geometry_ts: null },
    { ts: 100_801, geometry_ts: 100_700 },
  ])
})

test('repeated rollbacks never restore references for older uncertain timestamps', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  for (const ts of [100_500, 100_480, 100_700, 101_000, 100_980, 101_200]) {
    vi.setSystemTime(ts)
    await act(async () => observers.forEach((notify) => notify()))
  }
  for (const ts of [100_490, 100_701, 100_990, 101_300, 101_301]) samples(socket, 1, ts)
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual([
    { ts: 100_490, geometry_ts: null },
    { ts: 100_701, geometry_ts: null },
    { ts: 100_990, geometry_ts: null },
    { ts: 101_300, geometry_ts: null },
    { ts: 101_301, geometry_ts: 101_200 },
  ])
})

test('recovery waits beyond the clock guard and bridge timestamps received during rollback', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_500)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_480)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_501)
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100_501)
  vi.setSystemTime(100_502)
  samples(socket, 1, 100_800)
  for (const ts of [100_700, 100_800]) {
    vi.setSystemTime(ts)
    await act(async () => observers.forEach((notify) => notify()))
    samples(socket, 1, ts)
  }
  vi.setSystemTime(100_900)
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 101_001)
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual([
    { ts: 100_501, geometry_ts: null },
    { ts: 100_800, geometry_ts: null },
    { ts: 100_700, geometry_ts: null },
    { ts: 100_800, geometry_ts: null },
    { ts: 101_001, geometry_ts: 100_900 },
  ])
  expect(geometry.mock.calls.map(([, snapshot]) => snapshot.ts)).toEqual([100_900])
})

test('a slightly faster bridge clock cannot postpone recovery indefinitely', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100_500)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_480)
  samples(socket, 1, 100_500)
  for (const ts of [100_700, 101_700, 102_700]) {
    vi.setSystemTime(ts - 1)
    samples(socket, 1, ts + 20)
    vi.setSystemTime(ts)
    await act(async () => observers.forEach((notify) => notify()))
  }
  vi.setSystemTime(103_000)
  samples(socket, 1, 103_020)
  unmount()
  await act(async () => {})
  expect(storedReferences()).toEqual([
    { ts: 100_500, geometry_ts: null },
    { ts: 100_720, geometry_ts: null },
    { ts: 101_720, geometry_ts: 100_700 },
    { ts: 102_720, geometry_ts: 100_700 },
    { ts: 103_020, geometry_ts: 100_700 },
  ])
  expect(geometry.mock.calls.map(([, snapshot]) => snapshot.ts)).toEqual([100_700])
})

test('clock recovery before tracker discovery stores one unambiguous initial snapshot', async () => {
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  for (const ts of [100_010, 100_005]) {
    vi.setSystemTime(ts)
    await act(async () => observers.forEach((notify) => notify()))
  }
  vi.setSystemTime(100_200)
  const socket = await connect()
  samples(socket, 1, 99_995)
  vi.setSystemTime(100_301)
  samples(socket, 1, 100_301)
  unmount()
  await act(async () => {})
  expect(start.mock.calls[0][0].geometry?.ts).toBe(100_200)
  expect(geometry).not.toHaveBeenCalled()
  expect(storedReferences()).toEqual([
    { ts: 99_995, geometry_ts: null },
    { ts: 100_301, geometry_ts: 100_200 },
  ])
})

test('reconnection preserves clock uncertainty for delayed samples of the same video', async () => {
  const { result, unmount } = renderHook(() => useGazeCapture(caseContext))
  const first = await connect()
  for (const ts of [100_500, 100_480, 100_700]) {
    vi.setSystemTime(ts)
    await act(async () => observers.forEach((notify) => notify()))
  }
  vi.setSystemTime(101_000)
  act(() => result.current.retry())
  const second = await connect()
  samples(first, 1, 101_001) // A retired socket cannot contribute data.
  samples(second, 1, 100_490)
  samples(second, 1, 101_001)
  unmount()
  await act(async () => {})
  expect(start).toHaveBeenCalledTimes(1)
  expect(storedReferences()).toEqual([
    { ts: 100_490, geometry_ts: null },
    { ts: 101_001, geometry_ts: 100_700 },
  ])
})

test.each([
  ['no step back, including an unchanged reading', [100_100, 100_100, 100_300], 0, false],
  [
    'one step that takes several readings to catch up',
    [100_500, 100_480, 100_490, 100_499],
    1,
    false,
  ],
  ['a second step before the first has caught up', [100_500, 100_480, 100_490, 100_470], 2, false],
  [
    'a step after an earlier one was recovered from',
    [100_500, 100_480, 100_700, 100_900, 100_899],
    2,
    false,
  ],
  ['a changed clock', [100_500, 100_399, 100_700], 1, true],
])(
  'the finished event counts each observed step back of the clock once: %s',
  async (_case, readings, rollbacks, uncertain) => {
    const { unmount } = renderHook(() => useGazeCapture(caseContext))
    const socket = await connect()
    for (const [index, reading] of readings.entries()) {
      vi.setSystemTime(reading)
      // Both kinds of clock reading count: sample receipts and layout measurements.
      if (index % 2) await act(async () => observers.forEach((notify) => notify()))
      else samples(socket, 1, reading)
    }
    unmount()
    await act(async () => {})
    expect(enqueue).toHaveBeenLastCalledWith(
      'event',
      expect.objectContaining({
        payload: expect.objectContaining({
          state: 'capture_finished',
          clock_rollbacks: rollbacks,
          clock_uncertain: uncertain,
        }),
      }),
    )
  },
)

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

test.each(['questionnaire', 'diagnosis', 'case_outro'])(
  'rejects a runtime %s context before any collection',
  async (kind) => {
    const context = { ...caseContext, step_kind: kind } as GazeContext
    const { unmount } = renderHook(() => useGazeCapture(context))
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    unmount()
    expect(FakeSocket.all).toHaveLength(0)
    expect(observers.size).toBe(0)
    expect(start).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(geometry).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  },
)

test('leaving a video stops collection immediately and flushes only its pending samples', async () => {
  const pending = deferred<never>()
  upload.mockReturnValueOnce(pending.promise)
  const { rerender } = renderHook(
    ({ context }: { context: GazeContext | null }) => useGazeCapture(context),
    {
      initialProps: { context: caseContext as GazeContext | null },
    },
  )
  const socket = await connect()
  const staleObserver = [...observers][0]
  await act(async () => samples(socket, 502))
  rerender({ context: null })
  expect(socket.closed).toBe(true)
  expect(socket.sent).toContainEqual({ type: 'stop_gaze' })
  expect(observers.size).toBe(0)
  layout = { ...layout, aois: [{ id: 'diagnosis', x: 1, y: 1, w: 100, h: 100, priority: 0 }] }
  vi.setSystemTime(102_000)
  await act(async () => {
    staleObserver()
    samples(socket, 10, 102_001)
    pending.resolve({} as never)
    await vi.advanceTimersByTimeAsync(6000)
  })
  expect(FakeSocket.all).toHaveLength(1)
  expect(start).toHaveBeenCalledTimes(1)
  expect(geometry).not.toHaveBeenCalled()
  expect(upload.mock.calls.flatMap(([, batch]) => batch.map((sample) => sample.ts))).toEqual(
    Array.from({ length: 502 }, (_, i) => 100_001 + i),
  )
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 502 })
})

test('reconnection resumes the same screen row and preserves sample timestamps and offsets', async () => {
  const { result, unmount } = renderHook(() => useGazeCapture(caseContext))
  const first = await connect()
  await act(async () => samples(first, 3, 100_010))
  act(() => result.current.retry())
  const second = await connect()
  await act(async () => samples(second, 2, 104_000))
  unmount()
  await act(async () => {})
  expect(start).toHaveBeenCalledTimes(1)
  expect(first.closed).toBe(true)
  expect(second.sent).toContainEqual({ type: 'start_gaze' })
  expect(upload.mock.calls.flatMap(([, batch]) => batch.map((s) => s.ts))).toEqual([
    100010, 100011, 100012, 104000, 104001,
  ])
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 5 })
})

test('recording creation failure is visible and can recover without leaving the measured screen', async () => {
  start.mockRejectedValueOnce(new Error('offline'))
  const { result } = renderHook(() => useGazeCapture(caseContext))
  await connect()
  expect(result.current.issue).toBe('recording_failed')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  await connect()
  expect(start).toHaveBeenCalledTimes(2)
  expect(result.current.issue).toBeNull()
  expect(FakeSocket.all[FakeSocket.all.length - 1]!.sent).toContainEqual({ type: 'start_gaze' })
})

test('receiving valid gaze does not conceal a failed sample upload', async () => {
  upload.mockRejectedValueOnce(new Error('offline'))
  const { result } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  await act(async () => samples(socket, 500, 100_010))
  expect(result.current.state).toBe('tracking')
  expect(result.current.issue).toBe('upload_failed')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(result.current.issue).toBeNull()
})

test('late tracker discovery buffers early samples with the layouts actually observed during slow row creation', async () => {
  const pending = deferred<{ recording_id: number }>()
  start.mockReturnValue(pending.promise)
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = FakeSocket.all[0]
  await act(async () => socket.say({ type: 'status', connected: false }))
  expect(start).not.toHaveBeenCalled()
  await act(async () =>
    socket.say({ type: 'gaze_status', state: 'subscribing', connected: true, frequency: 90 }),
  )
  socket.say({ type: 'gaze', ts: 99999, lx: 0.3, ly: 0.4, lv: true })
  samples(socket, 1, 100010)
  vi.setSystemTime(100100)
  layout = { ...layout, active_modal: 'student_task' }
  await act(async () => observers.forEach((notify) => notify()))
  samples(socket, 1, 100110)
  await act(async () => pending.resolve({ recording_id: 7 }))
  unmount()
  await act(async () => {})
  expect(start.mock.calls[0][0].geometry?.ts).toBe(100000)
  expect(
    upload.mock.calls.flatMap(([, batch]) =>
      batch.map(({ ts, geometry_ts }) => ({ ts, geometry_ts })),
    ),
  ).toEqual([
    { ts: 100010, geometry_ts: 100000 },
    { ts: 100110, geometry_ts: 100100 },
  ])
  expect(geometry.mock.calls.map(([, g]) => g.ts)).toEqual([100100])
})

test('logs health transitions once per state rather than once per sample or count update', async () => {
  renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  await act(async () => samples(socket, 500, 100010))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  await act(async () => samples(socket, 120, 101010))
  const transitions = vi
    .mocked(enqueue)
    .mock.calls.map(([, body]) => body.payload as Record<string, unknown>)
  expect(transitions.map((p) => p.state)).toEqual(['connecting', 'waiting_samples', 'tracking'])
  expect(transitions.every((p) => p.step_kind === 'case_video' && p.step_index === 12)).toBe(true)
  expect(transitions.every((p) => !('lx' in p) && !('ly' in p))).toBe(true)
})

test('final completion failures remain visible and are recorded without sample coordinates', async () => {
  complete.mockRejectedValueOnce(new Error('server offline'))
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  samples(socket, 2, 100010)
  unmount()
  await act(async () => {})
  expect(gazeDeliveryWarning()).toBe('upload_failed')
  expect(enqueue).toHaveBeenLastCalledWith(
    'event',
    expect.objectContaining({
      event_type: 'gaze_capture_status',
      payload: expect.objectContaining({
        state: 'capture_finished',
        issue: 'completion_failed',
        saved: 2,
        unsent: 0,
      }),
    }),
  )
})

test('a previous participant finalizes without leaking warnings or telemetry to the next participant', async () => {
  const pending = deferred<never>()
  upload.mockReturnValue(pending.promise)
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  samples(socket, 2, 100010)
  unmount()
  resetGazeDeliverySession()
  vi.mocked(enqueue).mockClear()
  await act(async () => pending.resolve({} as never))
  expect(complete).toHaveBeenCalledWith(7, { sample_count: 2 })
  expect(gazeDeliveryWarning()).toBeNull()
  expect(enqueue).not.toHaveBeenCalled()
})

test('late row creation after leaving saves already received discovery frames without restarting the stream', async () => {
  const pending = deferred<{ recording_id: number }>()
  start.mockReturnValue(pending.promise)
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = FakeSocket.all[0]
  socket.say({ type: 'status', connected: false })
  socket.say({ type: 'gaze_status', connected: true, state: 'subscribing', frequency: 90 })
  samples(socket, 2, 100010)
  unmount()
  await act(async () => pending.resolve({ recording_id: 9 }))
  expect(upload).toHaveBeenCalledWith(
    9,
    expect.arrayContaining([
      expect.objectContaining({ ts: 100010, geometry_ts: 100000 }),
      expect.objectContaining({ ts: 100011, geometry_ts: 100000 }),
    ]),
    0,
  )
  expect(complete).toHaveBeenCalledWith(9, { sample_count: 2 })
  expect(
    socket.sent.filter((message) => (message as { type: string }).type === 'start_gaze'),
  ).toHaveLength(1)
  expect(socket.closed).toBe(true)
})

test('native gaze retains per-sample proof and maps only matching contemporaneous generations', async () => {
  const proof: nativeMapping.NativeViewport = {
    id: 'native-1',
    tab_id: 'a'.repeat(32),
    display: { x: 0, y: 0, w: 1920, h: 1080 },
    content: { x: 100, y: 100, w: 1600, h: 900 },
    css: { w: 1600, h: 900 },
    dpr: 1,
  }
  vi.spyOn(nativeMapping, 'getNativeViewportSnapshot').mockReturnValue({
    owner: 'person',
    capable: true,
    connection: 'connected',
    tabId: proof.tab_id,
    proof,
    errorCode: null,
  })
  vi.spyOn(nativeMapping, 'currentNativeViewport').mockReturnValue(proof)
  layout = {
    ...layout,
    native_viewport: proof,
    display_guard: { profile: 'native_viewport_v1', verified: true },
  }
  const { unmount, result } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  for (const [ts, viewport_ts, viewport_id] of [
    [100010, 100010, proof.id],
    [100020, 99900, proof.id],
    [100030, 100030, 'old-generation'],
  ] as const) {
    socket.say({
      type: 'gaze',
      ts,
      viewport_ts,
      viewport_id,
      lx: 0.3,
      ly: 0.4,
      lv: true,
      rv: false,
    })
  }
  expect(result.current.mappingVerified).toBe(false)
  socket.say({
    type: 'gaze',
    ts: 100040,
    viewport_ts: 100040,
    viewport_id: proof.id,
    lx: 0.3,
    ly: 0.4,
    lv: true,
    rv: false,
  })
  expect(result.current.mappingVerified).toBe(true)
  act(() => guardListeners.forEach((listener) => listener()))
  expect(result.current.mappingVerified).toBe(false)
  unmount()
  await act(async () => {})
  const saved = upload.mock.calls.flatMap(([, batch]) => batch)
  expect(saved.map((sample) => sample.geometry_ts)).toEqual([100000, null, null, 100000])
  expect(saved.map((sample) => sample.viewport_id)).toEqual([
    proof.id,
    proof.id,
    'old-generation',
    proof.id,
  ])
  expect(saved.map((sample) => sample.viewport_ts)).toEqual([100010, 99900, 100030, 100040])
})

test('a new native generation cannot borrow a previous layout or a future DOM measurement', async () => {
  let proof: nativeMapping.NativeViewport = {
    id: 'native-1',
    tab_id: 'a'.repeat(32),
    display: { x: 0, y: 0, w: 1920, h: 1080 },
    content: { x: 100, y: 100, w: 1600, h: 900 },
    css: { w: 1600, h: 900 },
    dpr: 1,
  }
  vi.spyOn(nativeMapping, 'getNativeViewportSnapshot').mockImplementation(() => ({
    owner: 'person',
    capable: true,
    connection: 'connected',
    tabId: proof.tab_id,
    proof,
    errorCode: null,
  }))
  vi.spyOn(nativeMapping, 'currentNativeViewport').mockImplementation(() => proof)
  layout = {
    ...layout,
    native_viewport: proof,
    display_guard: { profile: 'native_viewport_v1', verified: true },
  }
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  vi.setSystemTime(100100)
  proof = { ...proof, id: 'native-2', content: { ...proof.content, x: 150 } }
  layout = { ...layout, native_viewport: proof }
  for (const ts of [100050, 100150])
    socket.say({
      type: 'gaze',
      ts,
      viewport_ts: ts,
      viewport_id: proof.id,
      lx: 0.3,
      ly: 0.4,
      lv: true,
      rv: false,
    })
  unmount()
  await act(async () => {})
  const saved = upload.mock.calls.flatMap(([, batch]) => batch)
  expect(saved.map((sample) => sample.geometry_ts)).toEqual([null, 100100])
})

test('native resume cannot claim mapping before a verified DOM snapshot exists', async () => {
  const proof: nativeMapping.NativeViewport = {
    id: 'native-1',
    tab_id: 'a'.repeat(32),
    display: { x: 0, y: 0, w: 1920, h: 1080 },
    content: { x: 100, y: 100, w: 1600, h: 900 },
    css: { w: 1600, h: 900 },
    dpr: 1,
  }
  vi.spyOn(nativeMapping, 'getNativeViewportSnapshot').mockReturnValue({
    owner: 'person',
    capable: true,
    connection: 'connected',
    tabId: proof.tab_id,
    proof,
    errorCode: null,
  })
  vi.spyOn(nativeMapping, 'currentNativeViewport').mockReturnValue(proof)
  layout = {
    ...layout,
    native_viewport: proof,
    display_guard: { profile: 'native_viewport_v1', verified: false },
  }
  const { unmount, result } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  const send = (ts: number) =>
    socket.say({
      type: 'gaze',
      ts,
      viewport_ts: ts,
      viewport_id: proof.id,
      lx: 0.3,
      ly: 0.4,
      lv: true,
      rv: false,
    })
  send(100010)
  expect(result.current.mappingVerified).toBe(false)
  vi.setSystemTime(100100)
  layout = { ...layout, display_guard: { profile: 'native_viewport_v1', verified: true } }
  act(() => observers.forEach((listener) => listener()))
  send(100050)
  expect(result.current.mappingVerified).toBe(false)
  send(100150)
  expect(result.current.mappingVerified).toBe(true)
  unmount()
  await act(async () => {})
  expect(upload.mock.calls.flatMap(([, batch]) => batch).map((s) => s.geometry_ts)).toEqual([
    null,
    null,
    100100,
  ])
})

test('native proof changes cannot bypass rollback uncertainty or the display guard', async () => {
  let proof: nativeMapping.NativeViewport = {
    id: 'native-1',
    tab_id: 'a'.repeat(32),
    display: { x: 0, y: 0, w: 1920, h: 1080 },
    content: { x: 100, y: 100, w: 1600, h: 900 },
    css: { w: 1600, h: 900 },
    dpr: 1,
  }
  vi.spyOn(nativeMapping, 'getNativeViewportSnapshot').mockImplementation(() => ({
    owner: 'person',
    capable: true,
    connection: 'connected',
    tabId: proof.tab_id,
    proof,
    errorCode: null,
  }))
  vi.spyOn(nativeMapping, 'currentNativeViewport').mockImplementation(() => proof)
  layout = {
    ...layout,
    native_viewport: proof,
    display_guard: { profile: 'native_viewport_v1', verified: true },
  }
  const { unmount } = renderHook(() => useGazeCapture(caseContext))
  const socket = await connect()
  const send = (ts: number, viewport_id = proof.id) =>
    socket.say({
      type: 'gaze',
      ts,
      viewport_ts: ts,
      viewport_id,
      lx: 0.3,
      ly: 0.4,
      lv: true,
    })
  send(100_010)
  vi.setSystemTime(100_500)
  await act(async () => observers.forEach((notify) => notify()))
  vi.setSystemTime(100_480)
  proof = { ...proof, id: 'native-2', content: { ...proof.content, x: 150 } }
  layout = { ...layout, native_viewport: proof, active_modal: 'task_dialog' }
  send(100_490)
  vi.setSystemTime(100_700)
  await act(async () => observers.forEach((notify) => notify()))
  send(100_490) // A fresh native proof does not make this delayed timestamp safe.
  send(100_801)
  send(100_802, 'native-1')
  vi.mocked(displayGuardAllowsSample).mockReturnValue(false)
  send(100_803)
  unmount()
  await act(async () => {})
  const saved = upload.mock.calls.flatMap(([, batch]) => batch)
  expect(saved.map((sample) => sample.geometry_ts)).toEqual([
    100_000,
    null,
    null,
    100_700,
    null,
    null,
  ])
  expect(saved.map((sample) => sample.viewport_id)).toEqual([
    'native-1',
    'native-2',
    'native-2',
    'native-2',
    'native-1',
    'native-2',
  ])
  expect(saved.every((sample) => sample.viewport_ts === sample.ts && sample.lx === 0.3)).toBe(true)
})
