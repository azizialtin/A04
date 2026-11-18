import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { DisplayGuardSnapshot, DisplayMetrics } from '../../lib/displayGuard'
import type { NativeViewportState } from '../../lib/nativeViewport'
import { DisplayCheckSection } from './DisplayCheckPanel'

let guard: DisplayGuardSnapshot
let native: NativeViewportState
let metrics: DisplayMetrics
const retry = vi.fn()
const guardListeners = new Set<() => void>()

vi.mock('../../lib/displayGuard', async (original) => ({
  ...(await original<typeof import('../../lib/displayGuard')>()),
  getDisplayGuardSnapshot: () => guard,
  subscribeDisplayGuard: (listener: () => void) => {
    guardListeners.add(listener)
    return () => guardListeners.delete(listener)
  },
  readDisplayMetrics: () => metrics,
}))
vi.mock('../../lib/nativeViewport', async (original) => ({
  ...(await original<typeof import('../../lib/nativeViewport')>()),
  getNativeViewportSnapshot: () => native,
  subscribeNativeViewport: () => () => {},
  nativeViewport: { retry: () => retry() },
}))

const setGuard = (next: Partial<DisplayGuardSnapshot>) =>
  act(() => {
    guard = { ...guard, ...next }
    guardListeners.forEach((listener) => listener())
  })

beforeEach(() => {
  retry.mockClear()
  guardListeners.clear()
  metrics = {
    screenWidth: 1920,
    screenHeight: 1080,
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    x: 0,
    y: 0,
    dpr: 1,
    extended: false,
    visible: true,
    focused: true,
    viewport: { scale: 1, x: 0, y: 0 },
  }
  guard = {
    enabled: true,
    blocking: false,
    profile: 'lab_1080p',
    phase: 'verified',
    owner: 'P1',
    required: true,
    focusRequired: true,
    unverifiedContinuation: false,
    reasons: [],
    generation: 1,
  }
  native = {
    owner: 'P1',
    capable: false,
    tabId: null,
    proof: null,
    errorCode: null,
    connection: 'upgrade_required',
  }
})
afterEach(() => vi.useRealTimers())

const difference = (key: string) => document.querySelector(`[data-check="${key}"]`)
const openSection = () => {
  const details = document.querySelector('details')!
  fireEvent.click(details.querySelector('summary')!)
  expect(details).toHaveAttribute('open')
  return details
}
const connected = () => {
  native = { ...native, capable: true, connection: 'connected' }
  guard = { ...guard, profile: 'native_viewport_v1' }
}

test('starts collapsed and expands only differing settings as a vertical list', () => {
  metrics = { ...metrics, screenWidth: 1536, screenHeight: 864, dpr: 1.25 }
  guard = { ...guard, phase: 'blocked', reasons: ['screen_resolution', 'display_scale'] }
  render(<DisplayCheckSection />)
  expect(document.querySelector('details')).not.toHaveAttribute('open')
  expect(
    screen.getByText('Nicht alle Einstellungen stimmen – Details anzeigen.'),
  ).toBeInTheDocument()
  openSection()
  const resolution = difference('resolution')!
  expect(resolution.querySelector('.display-check__current')).toHaveTextContent(
    'Aktuell: 1536 × 864 (bei 125 % Skalierung/Zoom)',
  )
  expect(resolution.querySelector('.display-check__expected')).toHaveTextContent(
    'Vorgesehen: 1920 × 1080',
  )
  expect(difference('scale')).toHaveTextContent('Aktuell: 125 %')
  expect(difference('mapping')).toHaveTextContent('Aktuell: nicht aktiv')
  expect(difference('browser_area')).toBeNull()
  expect(difference('foreground')).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getByText(/Die Studie kann trotzdem fortgesetzt werden/)).toBeInTheDocument()
  expect(screen.getByText(/Skalierung → 100 %/)).toBeInTheDocument()
})

test('a correct display stays collapsed and has no differences or confirmation', () => {
  connected()
  render(<DisplayCheckSection />)
  expect(document.querySelector('details')).not.toHaveAttribute('open')
  expect(screen.getByText('Die Bildschirmeinstellungen sind in Ordnung.')).toBeInTheDocument()
  openSection()
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.queryByRole('button', { name: /Fortsetzen|fortfahren/ })).toBeNull()
})

test('follows changes without opening itself, and preserves the chosen open state', () => {
  vi.useFakeTimers()
  connected()
  render(<DisplayCheckSection />)
  metrics = { ...metrics, innerHeight: 969, outerHeight: 1040 }
  act(() => void vi.advanceTimersByTime(500))
  expect(document.querySelector('details')).not.toHaveAttribute('open')
  const details = openSection()
  expect(difference('fullscreen')).toHaveTextContent('Aktuell: nein')
  expect(difference('browser_area')).toHaveTextContent('Aktuell: 1920 × 969')
  metrics = { ...metrics, innerHeight: 1080, outerHeight: 1080 }
  act(() => void vi.advanceTimersByTime(500))
  expect(details).toHaveAttribute('open')
  expect(difference('fullscreen')).toBeNull()
  fireEvent.click(details.querySelector('summary')!)
  setGuard({ phase: 'blocked', reasons: ['window_size'] })
  expect(details).not.toHaveAttribute('open')
  expect(difference('mapping')).not.toBeNull()
})

test('unknown settings are listed and never summarized as ready', () => {
  connected()
  metrics = { ...metrics, extended: undefined }
  guard = { ...guard, phase: 'suspended', required: false }
  render(<DisplayCheckSection />)
  expect(
    screen.getByText('Einige Einstellungen konnten noch nicht geprüft werden – Details anzeigen.'),
  ).toBeInTheDocument()
  openSection()
  expect(difference('displays')).toHaveAttribute('data-status', 'info')
  expect(difference('displays')).toHaveTextContent('nicht feststellbar')
  expect(difference('mapping')).toBeNull()
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
})

test('offers fullscreen and a bridge reconnect, and reports a refused fullscreen', async () => {
  const request = vi.fn().mockRejectedValue(new Error('denied'))
  document.documentElement.requestFullscreen = request
  render(<DisplayCheckSection />)
  openSection()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Vollbild öffnen' }))
  })
  expect(request).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toHaveTextContent('Vollbild konnte nicht geöffnet werden')
  fireEvent.click(screen.getByRole('button', { name: 'Bridge erneut verbinden' }))
  expect(retry).toHaveBeenCalledOnce()
})

test('a bridge that is measuring cannot be reconnected by accident', () => {
  connected()
  native = { ...native, proof: { id: 'p' } as never }
  const { unmount } = render(<DisplayCheckSection />)
  openSection()
  expect(screen.getByRole('button', { name: 'Bridge erneut verbinden' })).toBeDisabled()
  unmount()
  native = { ...native, proof: null }
  render(<DisplayCheckSection />)
  openSection()
  expect(screen.getByRole('button', { name: 'Bridge erneut verbinden' })).toBeEnabled()
})

test('fullscreen follows the browser, so a zoomed fullscreen page is not sent out of it', () => {
  connected()
  metrics = { ...metrics, innerWidth: 1745, innerHeight: 982, dpr: 1.1 }
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(display-mode: fullscreen)' })),
  )
  try {
    render(<DisplayCheckSection />)
    openSection()
    expect(difference('fullscreen')).toBeNull()
    expect(difference('scale')).toHaveTextContent('Aktuell: 110 %')
  } finally {
    vi.unstubAllGlobals()
  }
})
