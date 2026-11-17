import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { displayGuard, type DisplayGuardScope } from '../lib/displayGuard'
import { enqueue } from '../lib/outbox'
import { useDisplayGuard } from './useDisplayGuard'

vi.mock('../lib/outbox', () => ({ enqueue: vi.fn() }))
vi.mock('../lib/displayGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/displayGuard')>()
  return {
    ...actual,
    DISPLAY_GUARD_ENABLED: true,
    displayGuard: new actual.DisplayGuardController(true),
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  for (const [key, value] of Object.entries({
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    screenX: 0,
    screenY: 0,
    devicePixelRatio: 1,
  }))
    vi.stubGlobal(key, value)
  vi.stubGlobal('screen', { width: 1920, height: 1080, isExtended: false })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.mocked(enqueue).mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('blocks browser zoom shortcuts and Ctrl-wheel only in required scope, keeping Ctrl-0 available', () => {
  const { rerender } = renderHook(({ scope }) => useDisplayGuard('person', scope), {
    initialProps: { scope: 'required' as DisplayGuardScope },
  })
  const key = (value: string) => {
    const event = new KeyboardEvent('keydown', {
      key: value,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    document.dispatchEvent(event)
    return event.defaultPrevented
  }
  expect(key('+')).toBe(true)
  expect(key('-')).toBe(true)
  expect(key('0')).toBe(false)
  const wheel = new WheelEvent('wheel', { ctrlKey: true, cancelable: true })
  document.dispatchEvent(wheel)
  expect(wheel.defaultPrevented).toBe(true)
  rerender({ scope: 'monitor' })
  expect(key('+')).toBe(false)
  const externalWheel = new WheelEvent('wheel', { ctrlKey: true, cancelable: true })
  document.dispatchEvent(externalWheel)
  expect(externalWheel.defaultPrevented).toBe(false)
})

test('checks focus and resize immediately, logs durable boundaries, and cleans up ownership', () => {
  const { result, unmount } = renderHook(() => useDisplayGuard('person', 'required'))
  act(() => {
    vi.advanceTimersByTime(500)
    displayGuard.resume()
  })
  expect(result.current.phase).toBe('verified')
  vi.stubGlobal('innerWidth', 1500)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(result.current.phase).toBe('blocked')
  expect(vi.mocked(enqueue).mock.calls.map(([, event]) => event.event_type)).toEqual([
    'display_guard_interrupted',
    'display_guard_resumed',
    'display_guard_interrupted',
  ])
  vi.stubGlobal('innerWidth', 1920)
  act(() => {
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(500)
    displayGuard.resume()
  })
  expect(result.current.phase).toBe('verified')
  vi.mocked(document.hasFocus).mockReturnValue(false)
  act(() => window.dispatchEvent(new Event('blur')))
  expect(result.current.reasons).toContain('window_focus')
  unmount()
  expect(displayGuard.getSnapshot().owner).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

test('queued resize and blur still interrupt when the browser already reports restored settings', () => {
  const { result } = renderHook(() => useDisplayGuard('person', 'required'))
  act(() => {
    vi.advanceTimersByTime(500)
    displayGuard.resume()
  })
  expect(result.current.phase).toBe('verified')
  act(() => window.dispatchEvent(new Event('resize')))
  expect(result.current.phase).toBe('blocked')
  act(() => {
    vi.advanceTimersByTime(500)
    displayGuard.resume()
  })
  expect(result.current.phase).toBe('verified')
  // hasFocus() is true, but the blur event proves focus was lost in the gap.
  act(() => window.dispatchEvent(new Event('blur')))
  expect(result.current.phase).toBe('blocked')
  expect(
    vi
      .mocked(enqueue)
      .mock.calls.filter(([, event]) => event.event_type === 'display_guard_interrupted'),
  ).toHaveLength(3)
})

test('monitor scope permits input but remembers queued display and focus changes for the next measured page', () => {
  const { result, rerender } = renderHook(({ scope }) => useDisplayGuard('person', scope), {
    initialProps: { scope: 'required' as DisplayGuardScope },
  })
  act(() => {
    vi.advanceTimersByTime(500)
    displayGuard.resume()
  })
  rerender({ scope: 'monitor' })
  expect(result.current).toMatchObject({ required: false, phase: 'verified' })
  act(() => window.dispatchEvent(new Event('blur')))
  expect(result.current.required).toBe(false)
  expect(displayGuard.check()).toBe(true)
  expect(result.current.phase).not.toBe('verified')
  rerender({ scope: 'required' })
  expect(result.current.required).toBe(true)
  expect(displayGuard.check()).toBe(false)
  expect(
    vi
      .mocked(enqueue)
      .mock.calls.filter(([, event]) => event.event_type === 'display_guard_interrupted'),
  ).toHaveLength(2)
})

function verifiedWithVisualViewport() {
  const viewport = Object.assign(new EventTarget(), {
    scale: 1,
    offsetLeft: 0,
    offsetTop: 0,
    width: 1920,
    height: 1080,
  })
  vi.stubGlobal('visualViewport', viewport)
  const hook = renderHook(() => useDisplayGuard('person', 'required'))
  act(() => {
    vi.advanceTimersByTime(500)
    displayGuard.resume()
  })
  expect(hook.result.current.phase).toBe('verified')
  vi.mocked(enqueue).mockClear()
  return { ...hook, viewport }
}

test('a scrollbar appearing or disappearing does not revoke a verified display', () => {
  const { result, viewport } = verifiedWithVisualViewport()
  // Windows reports a scrollbar as a narrower visual viewport and nothing else.
  for (const width of [1903, 1920, 1903]) {
    viewport.width = width
    act(() => void viewport.dispatchEvent(new Event('resize')))
    expect(result.current.phase).toBe('verified')
  }
  act(() => void vi.advanceTimersByTime(2000))
  expect(result.current.phase).toBe('verified')
  expect(enqueue).not.toHaveBeenCalled()
})

test('a pinch zoom reported by the visual viewport still revokes verification', () => {
  const { result, viewport } = verifiedWithVisualViewport()
  viewport.scale = 1.5
  act(() => void viewport.dispatchEvent(new Event('resize')))
  expect(result.current.phase).toBe('blocked')
  expect(vi.mocked(enqueue).mock.calls.map(([, event]) => event.event_type)).toEqual([
    'display_guard_interrupted',
  ])
})

test('a changed window is caught even when only the visual viewport announces it', () => {
  const { result, viewport } = verifiedWithVisualViewport()
  vi.stubGlobal('innerWidth', 1500)
  viewport.width = 1500
  act(() => void viewport.dispatchEvent(new Event('resize')))
  expect(result.current.phase).toBe('blocked')
  expect(result.current.reasons).toContain('window_size')
})

test('after a real resize, the new size is the baseline for later scrollbar changes', () => {
  const { result, viewport } = verifiedWithVisualViewport()
  vi.stubGlobal('innerHeight', 900)
  act(() => void window.dispatchEvent(new Event('resize')))
  expect(result.current.phase).toBe('blocked')
  vi.stubGlobal('innerHeight', 1080)
  act(() => void window.dispatchEvent(new Event('resize')))
  act(() => {
    vi.advanceTimersByTime(600)
    displayGuard.resume()
  })
  expect(result.current.phase).toBe('verified')
  vi.mocked(enqueue).mockClear()
  viewport.width = 1903
  act(() => void viewport.dispatchEvent(new Event('resize')))
  expect(result.current.phase).toBe('verified')
  expect(enqueue).not.toHaveBeenCalled()
})
