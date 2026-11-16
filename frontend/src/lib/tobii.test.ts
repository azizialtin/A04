import { afterEach, expect, test, vi } from 'vitest'

import { Bridge } from './tobii'

class Socket {
  static OPEN = 1
  static latest: Socket
  readyState = 1
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor() {
    Socket.latest = this
  }
  emit(message: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
}

afterEach(() => vi.unstubAllGlobals())

async function connect() {
  vi.stubGlobal('WebSocket', Socket)
  const promise = Bridge.connect('ws://test')
  Socket.latest.emit({ type: 'status', connected: false, frequency: 0 })
  return promise
}

test.each([
  [
    { lv: true, lx: 0.2, ly: 0.4, rv: true, rx: 0.6, ry: 0.8 },
    { x: 0.4, y: 0.6 },
  ],
  [
    { lv: true, lx: 0.2, ly: 0.4, rv: false, rx: 0.6, ry: 0.8 },
    { x: 0.2, y: 0.4 },
  ],
  [
    { lv: false, lx: 0.2, ly: 0.4, rv: true, rx: 0.6, ry: 0.8 },
    { x: 0.6, y: 0.8 },
  ],
  [
    { lv: true, lx: 0.2, ly: null, rv: true, rx: null, ry: 0.8 },
    { x: null, y: null },
  ],
  [
    { lx: 0.2, ly: 0.4, rx: 0.6, ry: 0.8 },
    { x: null, y: null },
  ],
  [
    { lv: true, lx: Infinity, ly: 0.4, rv: true, rx: 0.6, ry: 0.8 },
    { x: 0.6, y: 0.8 },
  ],
])('calibration uses only complete explicitly valid eye pairs: %j', async (sample, expected) => {
  const bridge = await connect(),
    onGaze = vi.fn()
  bridge.onGaze = onGaze
  Socket.latest.emit({ type: 'gaze', dz: 600, ...sample })
  const measured = onGaze.mock.calls[0][0]
  for (const key of ['x', 'y'] as const) {
    if (expected[key] === null) expect(measured[key]).toBeNull()
    else expect(measured[key]).toBeCloseTo(expected[key]!)
  }
  expect(measured.dz).toBe(600)
  bridge.close()
})

test('late tracker discovery refreshes actual frequency and physical display dimensions', async () => {
  const bridge = await connect(),
    onStatus = vi.fn()
  bridge.onStatus = onStatus
  Socket.latest.emit({
    type: 'status',
    connected: true,
    frequency: 120,
    display_w_mm: 345.4,
    display_h_mm: 194.3,
  })
  expect(bridge.status).toEqual({
    connected: true,
    frequency: 120,
    display_w_mm: 345.4,
    display_h_mm: 194.3,
  })
  expect(onStatus).toHaveBeenCalledWith(bridge.status)
  Socket.latest.emit({
    type: 'status',
    connected: true,
    frequency: -1,
    display_w_mm: null,
    display_h_mm: Infinity,
  })
  expect(bridge.status).toEqual({
    connected: true,
    frequency: 0,
    display_w_mm: null,
    display_h_mm: null,
  })
  bridge.close()
  expect(bridge.onStatus).toBeNull()
})
