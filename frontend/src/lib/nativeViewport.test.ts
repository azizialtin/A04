import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  NativeViewportController,
  browserViewportProblem,
  nativeSampleMatches,
  parseNativeViewport,
  type BrowserViewport,
  type NativeViewport,
} from './nativeViewport'

const viewport = (): BrowserViewport => ({
  w: 1600,
  h: 900,
  dpr: 1,
  focused: true,
  visible: true,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  extended: false,
  fingerprint: 'initial',
})
const proof = (tab = 'a'.repeat(32)): NativeViewport => ({
  id: 'native-generation-1',
  tab_id: tab,
  display: { x: 0, y: 0, w: 1920, h: 1080 },
  content: { x: 100, y: 100, w: 1600, h: 900 },
  css: { w: 1600, h: 900 },
  dpr: 1,
})
class Socket {
  static OPEN = 1
  readyState = 1
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: Record<string, unknown>[] = []
  closed = false
  send(value: string) {
    this.sent.push(JSON.parse(value))
  }
  close() {
    this.closed = true
  }
  receive(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}
const controllers: NativeViewportController[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  vi.stubGlobal('WebSocket', Socket)
  document.title = 'A04'
})
afterEach(() => {
  for (const c of controllers) c.configure(null, false)
  controllers.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function setup() {
  let css = viewport()
  const sockets: Socket[] = []
  const c = new NativeViewportController(
    () => css,
    Date.now,
    () => performance.now(),
    () => {
      const s = new Socket()
      sockets.push(s)
      return s as unknown as WebSocket
    },
  )
  controllers.push(c)
  c.configure('participant', true)
  const socket = sockets[0]
  const status = () => socket.receive({ type: 'status', native_viewport: true })
  const answer = (overrides: Record<string, unknown> = {}) => {
    const request = socket.sent[socket.sent.length - 1]!
    socket.receive({
      type: 'viewport_status',
      request_id: request.request_id,
      tab_id: request.tab_id,
      observed_at: Date.now(),
      ok: true,
      native_viewport: proof(String(request.tab_id)),
      ...overrides,
    })
  }
  return {
    c,
    socket,
    sockets,
    status,
    answer,
    change: (changes: Partial<BrowserViewport>) => {
      css = { ...css, ...changes }
    },
  }
}

test('accepts a measured windowed viewport, keeps heartbeat timestamps out of layout identity', () => {
  const s = setup()
  s.status()
  s.answer()
  expect(s.c.current()?.content).toEqual({ x: 100, y: 100, w: 1600, h: 900 })
  expect(document.title).toContain(`[A04:${s.c.getSnapshot().tabId}]`)
  const first = s.c.getSnapshot(),
    changed = vi.fn()
  s.c.subscribe(changed)
  vi.advanceTimersByTime(125)
  s.answer()
  expect(s.c.getSnapshot()).toBe(first)
  expect(changed).not.toHaveBeenCalled()
  expect(s.c.current()).not.toBeNull()
})

test('a measurement needs a current correlated request and matching tab', () => {
  const s = setup()
  s.status()
  s.answer({ request_id: 'old-request' })
  expect(s.c.current()).toBeNull()
  s.answer({ tab_id: 'b'.repeat(32) })
  expect(s.c.current()).toBeNull()
  s.answer()
  expect(s.c.current()).not.toBeNull()
})

test('stale, future and late replies cannot certify the current display', () => {
  for (const offset of [-501, 51]) {
    const s = setup()
    s.status()
    s.answer({ observed_at: Date.now() + offset })
    expect(s.c.current()).toBeNull()
    expect(s.c.getSnapshot().errorCode).toBe('stale_measurement')
  }
  const s = setup()
  s.status()
  s.answer()
  vi.advanceTimersByTime(501)
  expect(s.c.current()).toBeNull()
})

test('resize or focus change between request and response rejects the measurement', () => {
  const s = setup()
  s.status()
  s.change({ w: 1200, fingerprint: 'resized' })
  s.answer()
  expect(s.c.current()).toBeNull()
  s.change({ focused: false, fingerprint: 'blurred' })
  vi.advanceTimersByTime(125)
  expect(s.c.getSnapshot().errorCode).toBe('window_focus')
})

test('native capability never downgrades to guessed geometry after reconnect', () => {
  const s = setup()
  s.status()
  s.answer()
  s.socket.onclose?.()
  expect(s.c.current()).toBeNull()
  expect(s.c.getSnapshot().capable).toBe(true)
  vi.advanceTimersByTime(2000)
  s.sockets[1].receive({ type: 'status' })
  expect(s.c.getSnapshot().capable).toBe(true)
  expect(s.c.getSnapshot().errorCode).toBe('bridge_upgrade_required')
})

test('SoSci suspension drops the lease and title marker; a new participant gets a new identity', () => {
  const s = setup()
  s.status()
  s.answer()
  const oldTab = s.c.getSnapshot().tabId
  s.c.configure('participant', false)
  expect(s.c.current()).toBeNull()
  expect(document.title).toBe('A04')
  s.c.configure('participant', true)
  expect(s.c.getSnapshot().tabId).toBe(oldTab)
  expect(s.c.current()).toBeNull()
  s.c.configure('other', true)
  expect(s.socket.closed).toBe(true)
  expect(s.c.getSnapshot().capable).toBe(false)
  expect(s.c.getSnapshot().tabId).not.toBe(oldTab)
})

test('validates exact physical-to-CSS dimensions without assuming fullscreen or a DPI of one', () => {
  const v = { ...viewport(), w: 1200, h: 720, dpr: 1.25 }
  const p = {
    ...proof(),
    css: { w: 1200, h: 720 },
    dpr: 1.25,
    content: { x: 100, y: 100, w: 1500, h: 900 },
  }
  expect(parseNativeViewport(p, p.tab_id, v)).toEqual(p)
  expect(parseNativeViewport({ ...p, content: { ...p.content, w: 1600 } }, p.tab_id, v)).toBeNull()
  expect(parseNativeViewport({ ...p, content: { ...p.content, y: 300 } }, p.tab_id, v)).toBeNull()
  expect(parseNativeViewport({ ...p, dpr: 1 }, p.tab_id, v)).toBeNull()
})

test('pinch zoom, multiple monitors and invalid CSS metrics are never guessed', () => {
  expect(browserViewportProblem({ ...viewport(), scale: 1.2 })).toBe('viewport_zoom')
  expect(browserViewportProblem({ ...viewport(), offsetY: 8 })).toBe('viewport_zoom')
  expect(browserViewportProblem({ ...viewport(), extended: true })).toBe('multiple_displays')
  expect(browserViewportProblem({ ...viewport(), dpr: NaN })).toBe('invalid_dimensions')
})

test('every native sample requires a matching generation and contemporaneous bridge observation', () => {
  const p = proof()
  expect(nativeSampleMatches({ ts: 1000, viewport_ts: 1000, viewport_id: p.id }, p)).toBe(true)
  expect(nativeSampleMatches({ ts: 1000, viewport_ts: 950, viewport_id: p.id }, p)).toBe(true)
  for (const sample of [
    { ts: 1000, viewport_ts: 949, viewport_id: p.id },
    { ts: 1000, viewport_ts: 1051, viewport_id: p.id },
    { ts: 1000, viewport_ts: 1000, viewport_id: 'old' },
    { ts: 1000, viewport_id: p.id },
  ])
    expect(nativeSampleMatches(sample, p)).toBe(false)
  expect(nativeSampleMatches({ ts: 1000, viewport_ts: 1000, viewport_id: p.id }, null)).toBe(false)
})

test('a silent mapping handshake is bounded and cleanup cancels reconnect work', () => {
  const s = setup()
  vi.advanceTimersByTime(5000)
  expect(s.socket.closed).toBe(true)
  expect(s.c.getSnapshot().errorCode).toBe('bridge_unreachable')
  vi.advanceTimersByTime(2000)
  expect(s.sockets).toHaveLength(2)
  s.c.configure(null, false)
  vi.advanceTimersByTime(10000)
  expect(s.sockets).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(0)
})
