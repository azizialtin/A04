import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { DisplayGuardSnapshot, DisplayMetrics } from '../../lib/displayGuard'
import type { NativeViewportState } from '../../lib/nativeViewport'
import { DisplayCheckButton, DisplayCheckSection, DisplayCheckTable } from './DisplayCheckPanel'

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

const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) })
const cells = (name: string) =>
  within(row(name))
    .getAllByRole('cell')
    .map((cell) => cell.textContent)
const connected = () => {
  native = { ...native, capable: true, connection: 'connected' }
  guard = { ...guard, profile: 'native_viewport_v1' }
}

test('shows each setting as it is next to what is intended', () => {
  metrics = { ...metrics, screenWidth: 1536, screenHeight: 864, dpr: 1.25 }
  guard = { ...guard, phase: 'blocked', reasons: ['screen_resolution', 'display_scale'] }
  render(<DisplayCheckTable />)
  const resolution = within(row('Bildschirmauflösung')).getAllByRole('cell')
  expect(resolution.map((cell) => cell.textContent)).toEqual([
    '1536 × 864 (bei 125 % Skalierung/Zoom)',
    '1920 × 1080',
    '✕ weicht ab',
  ])
  const scale = within(row('Windows-Skalierung')).getAllByRole('cell')
  expect(scale.map((cell) => cell.textContent)).toEqual(['125 %', '100 %', '✕ weicht ab'])
  expect(cells('AOI-Zuordnung')[0]).toBe('nicht aktiv')
  // It explains the consequence and says outright that the study goes on.
  expect(screen.getByRole('status')).toHaveTextContent('keinen Bereichen (AOIs) zugeordnet')
  expect(screen.getByRole('status')).toHaveTextContent(
    'Die Studie kann trotzdem fortgesetzt werden',
  )
  expect(screen.getByText(/Skalierung → 100 %/)).toBeInTheDocument()
})

test('a correct display reads as in order, and has no confirmation to give', () => {
  connected()
  render(<DisplayCheckTable />)
  expect(screen.getByRole('status')).toHaveTextContent('entspricht den vorgesehenen Einstellungen')
  expect(cells('AOI-Zuordnung')).toEqual(['aktiv', 'aktiv', '✓ in Ordnung'])
  expect(screen.queryByRole('button', { name: /Fortsetzen|fortfahren/ })).toBeNull()
})

test('follows the display while it is open', () => {
  vi.useFakeTimers()
  render(<DisplayCheckTable />)
  expect(cells('Vollbild')[0]).toBe('ja')
  metrics = { ...metrics, innerHeight: 969, outerHeight: 1040 }
  act(() => void vi.advanceTimersByTime(500))
  expect(cells('Vollbild')).toEqual(['nein', 'ja', '✕ weicht ab'])
  expect(cells('Browserfläche')[0]).toBe('1920 × 969')
})

test('offers fullscreen and a bridge reconnect, and reports a refused fullscreen', async () => {
  const request = vi.fn().mockRejectedValue(new Error('denied'))
  document.documentElement.requestFullscreen = request
  render(<DisplayCheckTable />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Vollbild öffnen' }))
  })
  expect(request).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toHaveTextContent('Vollbild konnte nicht geöffnet werden')
  fireEvent.click(screen.getByRole('button', { name: 'Bridge erneut verbinden' }))
  expect(retry).toHaveBeenCalledOnce()
})

test('the opening section is folded away when all is well and open when it is not', () => {
  connected()
  const { unmount, container } = render(<DisplayCheckSection />)
  expect(container.querySelector('details')).not.toHaveAttribute('open')
  expect(screen.getByText(/Bildschirmeinstellung prüfen · in Ordnung/)).toBeInTheDocument()
  unmount()
  metrics = { ...metrics, dpr: 1.25 }
  guard = { ...guard, phase: 'blocked', reasons: ['display_scale'] }
  const second = render(<DisplayCheckSection />)
  expect(second.container.querySelector('details')).toHaveAttribute('open')
  expect(screen.getByText(/Einstellungen weichen ab/)).toBeInTheDocument()
})

test('on a measured page the notice appears only for a real deviation and opens on request', () => {
  render(<DisplayCheckButton />)
  expect(screen.queryByText(/keinen Bereichen zugeordnet/)).toBeNull()
  // The half second after a page change is not a deviation.
  setGuard({ phase: 'blocked', reasons: ['checking_display'] })
  expect(screen.queryByText(/keinen Bereichen zugeordnet/)).toBeNull()
  setGuard({ phase: 'blocked', reasons: ['window_size'] })
  expect(screen.getByText(/keinen Bereichen zugeordnet/)).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Einstellungen anzeigen' }))
  const dialog = screen.getByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })
  expect(within(dialog).getByRole('table')).toBeInTheDocument()
  // Unlike the blocking dialog it can simply be closed again.
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('the notice stays away on pages that are not measured and when the guard is off', () => {
  guard = { ...guard, required: false, phase: 'blocked', reasons: ['window_size'] }
  const { unmount } = render(<DisplayCheckButton />)
  expect(screen.queryByRole('status')).toBeNull()
  unmount()
  guard = { ...guard, enabled: false, required: true }
  render(<DisplayCheckButton />)
  expect(screen.queryByRole('status')).toBeNull()
})

test('when only the focus is missing, the notice says what to do', () => {
  guard = { ...guard, phase: 'blocked', reasons: ['window_focus'] }
  render(<DisplayCheckButton />)
  expect(screen.getByRole('status')).toHaveTextContent('Bitte einmal in die Studienseite klicken')
})

test('the dialog is not a child of the click-through status stack', () => {
  guard = { ...guard, phase: 'blocked', reasons: ['window_size'] }
  const { container } = render(
    <div className="gaze-health-stack">
      <DisplayCheckButton />
    </div>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Einstellungen anzeigen' }))
  const dialog = screen.getByRole('dialog')
  expect(container.contains(dialog)).toBe(false)
  expect(dialog.parentElement).toBe(document.body)
})

test('a bridge that is measuring cannot be reconnected by accident', () => {
  connected()
  native = { ...native, proof: { id: 'p' } as never }
  const { unmount } = render(<DisplayCheckTable />)
  expect(screen.getByRole('button', { name: 'Bridge erneut verbinden' })).toBeDisabled()
  unmount()
  native = { ...native, proof: null }
  render(<DisplayCheckTable />)
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
    render(<DisplayCheckTable />)
    expect(cells('Vollbild')[0]).toBe('ja')
  } finally {
    vi.unstubAllGlobals()
  }
})
