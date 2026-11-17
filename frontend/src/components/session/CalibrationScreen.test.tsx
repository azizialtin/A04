import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { gazeApi } from '../../api/gaze'
import { VALIDATION_TARGETS } from '../../lib/calibration'
import { Bridge, type BridgeGaze, type BridgeStatus } from '../../lib/tobii'
import type { DisplayGuardSnapshot } from '../../lib/displayGuard'
import CalibrationScreen from './CalibrationScreen'

vi.mock('../../api/gaze', () => ({ gazeApi: { saveCalibration: vi.fn() } }))
vi.mock('../../lib/tobii', () => ({ Bridge: { connect: vi.fn() }, TOBII_WS_URL: 'ws://test' }))
let guard: DisplayGuardSnapshot
const guardListeners = new Set<() => void>()
vi.mock('../../lib/displayGuard', () => ({
  checkDisplayGuard: () =>
    !guard.enabled || !guard.required || guard.phase === 'verified' || guard.unverifiedContinuation,
  getDisplayGuardSnapshot: () => guard,
  subscribeDisplayGuard: (listener: () => void) => {
    guardListeners.add(listener)
    return () => guardListeners.delete(listener)
  },
}))

const bridge = {
  status: { connected: true, frequency: 120, display_w_mm: 500, display_h_mm: 280 },
  onGaze: null as ((sample: BridgeGaze) => void) | null,
  onStatus: null as ((status: BridgeStatus) => void) | null,
  request: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  guard = {
    enabled: false,
    phase: 'disabled',
    owner: null,
    required: false,
    focusRequired: false,
    reasons: [],
    generation: 0,
    unverifiedContinuation: false,
  }
  guardListeners.clear()
  bridge.onGaze = null
  bridge.onStatus = null
  bridge.status = { connected: true, frequency: 120, display_w_mm: 500, display_h_mm: 280 }
  bridge.request.mockResolvedValue({ ok: true })
  vi.mocked(Bridge.connect).mockResolvedValue(bridge as unknown as Bridge)
  vi.mocked(gazeApi.saveCalibration).mockResolvedValue({} as never)
  for (const [key, value] of Object.entries({
    screen: { width: 1920, height: 1080 },
    innerWidth: 1920,
    outerWidth: 1920,
    innerHeight: 1080,
    outerHeight: 1080,
    screenX: 0,
    screenY: 0,
  }))
    vi.stubGlobal(key, value)
})

test.each(['blocked', 'ready'] as const)(
  'unverified continuation cannot start calibration while the display is %s',
  async (phase) => {
    guard = {
      ...guard,
      enabled: true,
      required: true,
      phase,
      unverifiedContinuation: true,
    }
    const complete = await open()
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(bridge.request).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
    expect(gazeApi.saveCalibration).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Kalibrierung starten' })).toBeVisible()
  },
)

test('an interrupted calibration cannot succeed after the display has already been restored', async () => {
  guard = { ...guard, enabled: true, required: true, phase: 'verified' }
  await open()
  await act(() => vi.advanceTimersByTimeAsync(1200))
  guard = { ...guard, phase: 'blocked', generation: 1 }
  act(() => guardListeners.forEach((listener) => listener()))
  expect(bridge.send).toHaveBeenCalledWith('calibrate_abort')
  guard = { ...guard, phase: 'verified', generation: 2 }
  act(() => guardListeners.forEach((listener) => listener()))
  await act(() => vi.advanceTimersByTimeAsync(1200))
  expect(vi.mocked(gazeApi.saveCalibration).mock.calls.map(([record]) => record.status)).toEqual([
    'failed',
  ])
  expect(screen.getByText(/Anzeige wurde während der Kalibrierung verändert/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Kalibrierung wiederholen' }))
  await validate((index) => [valid(index)])
  expect(vi.mocked(gazeApi.saveCalibration).mock.calls.map(([record]) => record.status)).toEqual([
    'failed',
    'success',
  ])
})

test('guarded calibration preserves the established fullscreen mode', async () => {
  guard = { ...guard, enabled: true, required: true, phase: 'verified' }
  const enter = vi.fn().mockResolvedValue(undefined)
  const exit = vi.fn().mockResolvedValue(undefined)
  const original = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
  const originalRequest = document.documentElement.requestFullscreen
  const originalExit = document.exitFullscreen
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: document.documentElement,
  })
  document.documentElement.requestFullscreen = enter
  document.exitFullscreen = exit
  try {
    await open()
    await validate((index) => [valid(index)])
    expect(vi.mocked(gazeApi.saveCalibration).mock.calls[0][0].status).toBe('success')
    expect(enter).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  } finally {
    if (original) Object.defineProperty(document, 'fullscreenElement', original)
    else Reflect.deleteProperty(document, 'fullscreenElement')
    document.documentElement.requestFullscreen = originalRequest
    document.exitFullscreen = originalExit
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function open() {
  const complete = vi.fn()
  await act(async () => {
    render(<CalibrationScreen onComplete={complete} />)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Kalibrierung starten' }))
  return complete
}

test('a tracker discovered after the handshake becomes available without reloading', async () => {
  bridge.status.connected = false
  await act(async () => {
    render(<CalibrationScreen onComplete={vi.fn()} />)
  })
  expect(screen.queryByRole('button', { name: 'Kalibrierung starten' })).not.toBeInTheDocument()
  act(() =>
    bridge.onStatus?.({
      connected: true,
      frequency: 120,
      display_w_mm: 345.4,
      display_h_mm: 194.3,
    }),
  )
  expect(screen.getByRole('button', { name: 'Kalibrierung starten' })).toBeEnabled()
})

test('angular accuracy uses refreshed display width and measured viewing distance', async () => {
  await open()
  bridge.status.display_w_mm = 345.4
  await validate((index) => [{ ...valid(index), x: valid(index).x! + 0.01 }])
  const saved = vi.mocked(gazeApi.saveCalibration).mock.calls[0][0]
  expect(saved.status).toBe('success')
  expect(saved.mean_offset_degrees).toBeCloseTo((Math.atan2(0.01 * 345.4, 600) * 180) / Math.PI, 8)
})

async function validate(samples: (index: number) => BridgeGaze[]) {
  await act(() => vi.advanceTimersByTimeAsync(6000))
  for (let index = 0; index < VALIDATION_TARGETS.length; index++) {
    await act(() => vi.advanceTimersByTimeAsync(600))
    for (const sample of samples(index)) bridge.onGaze?.(sample)
    await act(() => vi.advanceTimersByTimeAsync(1000))
  }
}

const valid = (index: number): BridgeGaze => ({ ...VALIDATION_TARGETS[index], dz: 600 })

for (const [name, samples] of [
  ['no gaze', () => []],
  ['one unmeasured target', (index: number) => (index === 2 ? [] : [valid(index)])],
  [
    'nonfinite positions',
    () => [
      { x: NaN, y: 0.5, dz: 600 },
      { x: 0.5, y: Infinity, dz: 600 },
    ],
  ],
  ['incomplete positions', () => [{ x: 0.5, y: null, dz: 600 }]],
] as const) {
  test(`validation fails with ${name} and retains the measured target records`, async () => {
    const complete = await open()
    await validate(samples)
    const saved = vi.mocked(gazeApi.saveCalibration).mock.calls[0][0]
    expect(saved.status).toBe('failed')
    expect(saved.mean_offset).toBeNull()
    expect(saved.mean_offset_degrees).toBeNull()
    expect(saved.points).toHaveLength(4)
    expect(saved.points.some((point) => point.samples === 0 && point.offset === null)).toBe(true)
    expect(screen.getByText('Die Kalibrierung ist fehlgeschlagen.')).toBeVisible()
    expect(screen.queryByText(/Mittlere Abweichung/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Weiter' })).not.toBeInTheDocument()
    expect(complete).not.toHaveBeenCalled()
    expect(bridge.send).toHaveBeenCalledWith('stop_gaze')
    fireEvent.click(screen.getByRole('button', { name: 'Ohne Eye-Tracking fortfahren' }))
    await act(async () => {})
    expect(complete).toHaveBeenCalledTimes(1)
    expect(vi.mocked(gazeApi.saveCalibration).mock.calls[1][0].status).toBe('skipped')
  })
}

test('valid samples at every target succeed, exclude invalid samples, and can continue', async () => {
  const complete = await open()
  await validate((index) => [
    { x: null, y: null, dz: null },
    { x: NaN, y: 0.5, dz: Infinity },
    valid(index),
  ])
  const saved = vi.mocked(gazeApi.saveCalibration).mock.calls[0][0]
  expect(saved.status).toBe('success')
  expect(saved.mean_offset).toBe(0)
  expect(saved.points.map((point) => point.samples)).toEqual([1, 1, 1, 1])
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(complete).toHaveBeenCalledTimes(1)
})

test('retry replaces a failed validation with new measurements', async () => {
  await open()
  await validate(() => [])
  fireEvent.click(screen.getByRole('button', { name: 'Kalibrierung wiederholen' }))
  await validate((index) => [valid(index)])
  expect(vi.mocked(gazeApi.saveCalibration).mock.calls.map(([value]) => value.status)).toEqual([
    'failed',
    'success',
  ])
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled()
})
