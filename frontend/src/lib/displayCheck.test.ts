import { describe, expect, test } from 'vitest'

import { displayCheckSummary, displayChecklist, fillsScreen } from './displayCheck'
import type { DisplayMetrics } from './displayGuard'

const lab: DisplayMetrics = {
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
// The 15.6" lab laptops as delivered: 1920 × 1080 at 125% Windows scaling, fullscreen.
const scaled: DisplayMetrics = {
  ...lab,
  screenWidth: 1536,
  screenHeight: 864,
  innerWidth: 1536,
  innerHeight: 864,
  outerWidth: 1536,
  outerHeight: 864,
  dpr: 1.25,
}
type Guard = Parameters<typeof displayChecklist>[1]
const verified: Guard = { phase: 'verified', reasons: [], required: true }
const waiting: Guard = { phase: 'blocked', reasons: ['display_scale'], required: true }
const legacy = { capable: false, connection: 'upgrade_required' } as const
const native = { capable: true, connection: 'connected' } as const

const status = (rows: ReturnType<typeof displayChecklist>) =>
  Object.fromEntries(rows.map((row) => [row.key, row.status]))

describe('display checklist', () => {
  test('the intended lab setup is all in order', () => {
    const rows = displayChecklist(lab, verified, native)
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(['ok']))
    expect(displayCheckSummary(rows)).toBe('ok')
    expect(rows.find((row) => row.key === 'resolution')?.current).toEqual({
      id: 'size',
      values: { w: 1920, h: 1080, value: 100 },
    })
  })

  test('125% scaling without a measuring bridge names every setting that keeps gaze unmapped', () => {
    const rows = displayChecklist(scaled, waiting, legacy)
    expect(status(rows)).toMatchObject({
      bridge: 'warn',
      resolution: 'fail',
      scale: 'fail',
      browser_area: 'fail',
      fullscreen: 'ok',
      displays: 'ok',
      mapping: 'fail',
    })
    expect(rows.find((row) => row.key === 'scale')?.current.values).toEqual({ value: 125 })
    expect(rows.find((row) => row.key === 'resolution')?.current.values).toEqual({
      w: 1536,
      h: 864,
      value: 125,
    })
    expect(displayCheckSummary(rows)).toBe('fail')
  })

  test('with a measuring bridge the same deviations are layout notes, not failures', () => {
    const rows = displayChecklist(scaled, verified, native)
    expect(status(rows)).toMatchObject({
      bridge: 'ok',
      resolution: 'warn',
      scale: 'warn',
      browser_area: 'warn',
      mapping: 'ok',
    })
    expect(displayCheckSummary(rows)).toBe('warn')
  })

  test('a maximised window is not fullscreen', () => {
    const maximised = { ...lab, innerHeight: 969, outerHeight: 1040 }
    expect(fillsScreen(maximised)).toBe(false)
    expect(fillsScreen(lab)).toBe(true)
    expect(status(displayChecklist(maximised, waiting, legacy))).toMatchObject({
      fullscreen: 'fail',
      browser_area: 'fail',
      resolution: 'ok',
      scale: 'ok',
    })
    expect(
      displayChecklist(maximised, verified, native).find((row) => row.key === 'fullscreen')
        ?.expected.id,
    ).toBe('fullscreen_recommended')
  })

  test('a second display and a pinch zoom fail with either bridge', () => {
    for (const bridge of [legacy, native]) {
      const rows = displayChecklist(
        { ...lab, extended: true, viewport: { scale: 1.5, x: 0, y: 0 } },
        waiting,
        bridge,
      )
      expect(status(rows)).toMatchObject({ displays: 'fail', zoom_gesture: 'fail' })
    }
  })

  test('what the browser does not expose is shown as unknown, never as correct', () => {
    const rows = displayChecklist({ ...lab, extended: undefined }, verified, native)
    const displays = rows.find((row) => row.key === 'displays')
    expect(displays).toMatchObject({ status: 'info', current: { id: 'unknown' } })
  })

  test('an unreachable bridge fails; one still connecting is only pending', () => {
    const at = (connection: 'unreachable' | 'connecting' | 'idle' | 'permission_pending') =>
      displayChecklist(lab, waiting, { capable: false, connection })[0]
    expect(at('unreachable')).toMatchObject({
      status: 'fail',
      current: { id: 'bridge_unreachable' },
    })
    expect(at('connecting').status).toBe('info')
    expect(at('idle').status).toBe('info')
    expect(at('permission_pending').status).toBe('info')
  })

  test('focus is a reminder before the study and a failure on a measured page', () => {
    const away = { ...lab, focused: false }
    const before = displayChecklist(away, { phase: 'ready', reasons: [], required: false }, native)
    const during = displayChecklist(away, waiting, native)
    expect(status(before).foreground).toBe('warn')
    expect(status(during).foreground).toBe('fail')
  })

  test('mapping distinguishes active, ready, still checking, paused and not active', () => {
    const mapping = (guard: Parameters<typeof displayChecklist>[1]) =>
      displayChecklist(lab, guard, native).find((row) => row.key === 'mapping')?.current.id
    expect(mapping(verified)).toBe('mapping_active')
    expect(mapping({ phase: 'ready', reasons: [], required: false })).toBe('mapping_ready')
    expect(mapping({ phase: 'blocked', reasons: ['checking_display'], required: true })).toBe(
      'mapping_checking',
    )
    expect(mapping({ phase: 'blocked', reasons: [], required: true })).toBe('mapping_checking')
    expect(mapping({ phase: 'suspended', reasons: [], required: false })).toBe('mapping_paused')
    expect(mapping(waiting)).toBe('mapping_waiting')
  })

  test('values the browser reports as nonsense do not crash or pass', () => {
    const rows = displayChecklist(
      { ...lab, dpr: Number.NaN, screenWidth: 0, innerWidth: Number.POSITIVE_INFINITY },
      waiting,
      legacy,
    )
    expect(status(rows)).toMatchObject({ scale: 'fail', resolution: 'fail', browser_area: 'fail' })
    expect(rows.find((row) => row.key === 'scale')?.current.values).toEqual({ value: 0 })
  })
})

describe('what the browser itself reports', () => {
  test('fullscreen at a page zoom other than 100% is still fullscreen', () => {
    // F11 at 110%: the page measures 1745 × 982 against an unzoomed 1920 × 1080 screen.
    const zoomed = { ...lab, innerWidth: 1745, innerHeight: 982, dpr: 1.1 }
    expect(fillsScreen(zoomed)).toBe(false)
    const row = (browserFullscreen: boolean) =>
      displayChecklist(zoomed, verified, native, browserFullscreen).find(
        (entry) => entry.key === 'fullscreen',
      )
    expect(row(true)).toMatchObject({ status: 'ok', current: { id: 'yes' } })
    expect(row(false)).toMatchObject({ status: 'warn', current: { id: 'no' } })
    // The zoom itself is still named, on its own row.
    expect(status(displayChecklist(zoomed, verified, native, true)).scale).toBe('warn')
  })

  test('a scaled screen is shown as scaled, not as a wrong resolution setting', () => {
    const resolution = (metrics: DisplayMetrics) =>
      displayChecklist(metrics, waiting, legacy).find((entry) => entry.key === 'resolution')
        ?.current
    expect(resolution(scaled)).toEqual({
      id: 'size_scaled',
      values: { w: 1536, h: 864, value: 125 },
    })
    expect(resolution(lab)?.id).toBe('size')
    // A genuinely different panel at 100% is a resolution matter.
    expect(resolution({ ...lab, screenWidth: 2560, screenHeight: 1440 })?.id).toBe('size')
  })
})
