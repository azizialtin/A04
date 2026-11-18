import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { openGazeConnection } from './gazeConnection'

const lease = vi.hoisted(() => ({ tab: null as string | null, listeners: new Set<() => void>() }))
vi.mock('./nativeViewport', () => ({
  nativeGazeLease: () => (lease.tab ? { tab_id: lease.tab } : {}),
  subscribeNativeViewport: (listener: () => void) => {
    lease.listeners.add(listener)
    return () => lease.listeners.delete(listener)
  },
}))

class Socket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: unknown[] = []
  closed = false
  constructor() {
    Socket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
  }
  say(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}
const health = vi.fn()
const sample = vi.fn()
let connection: ReturnType<typeof openGazeConnection>
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  })
  Socket.all = []
  lease.tab = null
  lease.listeners.clear()
  health.mockReset()
  sample.mockReset()
  vi.stubGlobal('WebSocket', Socket)
  connection = openGazeConnection({
    onHealth: health,
    onSample: sample,
    onReady: (_rate, start) => start(),
  })
})
afterEach(() => {
  connection.close()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const status = () =>
  Socket.all[Socket.all.length - 1]!.say({ type: 'status', connected: true, frequency: 120 })
const gaze = (valid = true) =>
  Socket.all[Socket.all.length - 1]!.say({
    type: 'gaze',
    ts: Date.now(),
    lv: valid,
    lx: 0.4,
    ly: 0.5,
  })

test('reconnects after denial/disconnect and accepts data only from the current socket', async () => {
  const old = Socket.all[0]
  const stale = old.onmessage!
  old.onerror!()
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'bridge_unreachable' }))
  await vi.advanceTimersByTimeAsync(2000)
  expect(Socket.all).toHaveLength(2)
  expect(old.closed).toBe(true)
  status()
  gaze()
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'tracking', received: 1, valid: 1 }),
  )
  stale({ data: JSON.stringify({ type: 'gaze', ts: 1, lv: true, lx: 0.3, ly: 0.5 }) })
  expect(sample).toHaveBeenCalledTimes(1)
})
test('a manual retry recovers immediately after permission changes', () => {
  Socket.all[0].onerror!()
  connection.retry()
  expect(Socket.all).toHaveLength(2)
  status()
  gaze()
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracking' }))
})
test('tracker connected or global streaming status alone never means this client receives samples', async () => {
  status()
  Socket.all[0].say({
    type: 'gaze_status',
    connected: true,
    state: 'streaming',
    sample_count: 500,
    valid_sample_count: 500,
  })
  expect(health).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'tracking' }))
  await vi.advanceTimersByTimeAsync(6000)
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'no_samples', received: 0 }),
  )
})
test('missing tracker requests rediscovery and recovers on the same socket', () => {
  Socket.all[0].say({ type: 'status', connected: false })
  expect(Socket.all[0].sent).toContainEqual({ type: 'start_gaze' })
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracker_missing' }))
  Socket.all[0].say({ type: 'gaze_status', connected: true, state: 'subscribing', frequency: 60 })
  gaze()
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracking' }))
})
test('subscription errors stay distinct from an unreachable bridge', () => {
  status()
  Socket.all[0].say({
    type: 'gaze_status',
    connected: true,
    state: 'error',
    error_code: 'subscription_failed',
  })
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'stream_failed', error_code: 'subscription_failed' }),
  )
})
test('invalid-only samples cannot be reported healthy and counters update once a second', async () => {
  status()
  for (let i = 0; i < 120; i++) gaze(false)
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'invalid_samples', valid: 0 }),
  )
  expect(health.mock.calls.length).toBeLessThan(6)
  await vi.advanceTimersByTimeAsync(1000)
  gaze()
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'tracking', received: 121, valid: 1 }),
  )
})
test('validity strings and null coordinates do not become valid eyes', () => {
  status()
  Socket.all[0].say({ type: 'gaze', ts: 1, lv: 'true', lx: 0.1, ly: 0.1 })
  Socket.all[0].say({ type: 'gaze', ts: 2, lv: true, lx: null, ly: 0.1 })
  expect(health).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'tracking' }))
})
test('the handshake is bounded and unmount cancels all recovery work', async () => {
  await vi.advanceTimersByTimeAsync(5000)
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'bridge_unreachable' }))
  connection.close()
  await vi.advanceTimersByTimeAsync(30000)
  expect(Socket.all).toHaveLength(1)
})
test('a real-frame stream announces mock mode explicitly', () => {
  Socket.all[0].say({ type: 'status', connected: true, source_mode: 'mock' })
  gaze()
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'tracking', mock: true }),
  )
})

test('a stalled stream really reconnects instead of repeatedly postponing its retry', async () => {
  status()
  await vi.advanceTimersByTimeAsync(8000)
  expect(Socket.all).toHaveLength(2)
  status()
  gaze()
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracking' }))
})

test('SDK failures retain their diagnostic code without exposing free-text bridge errors', () => {
  Socket.all[0].say({ type: 'status', connected: false })
  Socket.all[0].say({
    type: 'gaze_status',
    state: 'error',
    error_code: 'sdk_unavailable',
    error: 'private path',
  })
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'tracker_missing', error_code: 'sdk_unavailable' }),
  )
  expect(health.mock.lastCall![0]).not.toHaveProperty('error')
})

test('a native capability arriving after capture starts rebinds that socket without trusting its old stream', () => {
  status()
  gaze()
  const old = Socket.all[0],
    oldHandler = old.onmessage!
  expect(old.sent).toContainEqual({ type: 'start_gaze' })
  lease.tab = 'a'.repeat(32)
  lease.listeners.forEach((listener) => listener())
  expect(old.closed).toBe(true)
  expect(old.sent).toContainEqual({ type: 'stop_gaze' })
  expect(Socket.all).toHaveLength(2)
  status()
  expect(Socket.all[1].sent).toContainEqual({ type: 'start_gaze', tab_id: lease.tab })
  const previous = sample.mock.calls.length
  oldHandler({ data: JSON.stringify({ type: 'gaze', ts: 10, lv: true, lx: 0.4, ly: 0.5 }) })
  expect(sample).toHaveBeenCalledTimes(previous)
  gaze()
  expect(sample).toHaveBeenCalledTimes(previous + 1)
  connection.close()
  expect(lease.listeners.size).toBe(0)
})

function probe() {
  connection.close()
  health.mockClear()
  connection = openGazeConnection({
    probeOnly: true,
    onHealth: health,
    onSample: sample,
    // Even a caller requesting a start must not turn a probe into capture.
    onReady: (_rate, start) => start(),
  })
  return Socket.all[Socket.all.length - 1]
}

test('preflight reports tracker discovery without ever requesting or counting gaze', async () => {
  const socket = probe()
  status()
  socket.say({ type: 'gaze_status', connected: true, state: 'streaming', sample_count: 100 })
  gaze()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(health).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'tracker_ready', received: 0, valid: 0 }),
  )
  expect(sample).not.toHaveBeenCalled()
  expect(socket.sent).toEqual([])
  connection.close()
  expect(socket.sent).toEqual([])
})

test('missing preflight tracker never starts streaming to request rediscovery', () => {
  const socket = probe()
  socket.say({ type: 'status', connected: false })
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracker_missing' }))
  expect(socket.sent).toEqual([])
  socket.say({ type: 'gaze_status', connected: true, state: 'ready' })
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracker_ready' }))
  socket.say({ type: 'gaze_status', connected: false, state: 'discovering' })
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracker_missing' }))
  expect(socket.sent).toEqual([])
  expect(sample).not.toHaveBeenCalled()
})

test('a preflight retry remains a status-only connection', () => {
  const socket = probe()
  socket.onerror!()
  connection.retry()
  status()
  gaze()
  expect(Socket.all.every((ws) => ws.sent.length === 0)).toBe(true)
  expect(sample).not.toHaveBeenCalled()
  expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'tracker_ready' }))
})
