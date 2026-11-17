// What the study lead sees before a session: each display setting as the
// browser reports it, next to what the study expects. Nothing here decides
// whether gaze is admitted — the display guard does that — it only explains it.

import type { DisplayGuardSnapshot, DisplayMetrics } from './displayGuard'
import type { NativeViewportState } from './nativeViewport'

export type DisplayCheckStatus = 'ok' | 'warn' | 'fail' | 'info'

export type DisplayCheckKey =
  | 'bridge'
  | 'resolution'
  | 'scale'
  | 'browser_area'
  | 'fullscreen'
  | 'displays'
  | 'zoom_gesture'
  | 'foreground'
  | 'mapping'

export interface DisplayCheckRow {
  key: DisplayCheckKey
  status: DisplayCheckStatus
  /** Translation key under `check.value`, with its interpolation values. */
  current: { id: string; values?: Record<string, number> }
  expected: { id: string; values?: Record<string, number> }
}

export const EXPECTED_WIDTH = 1920
export const EXPECTED_HEIGHT = 1080

const near = (value: number, expected: number, tolerance = 1) =>
  Number.isFinite(value) && Math.abs(value - expected) <= tolerance

/** The page covers the whole screen: browser fullscreen, entered by F11 or by the page. */
export function fillsScreen(m: DisplayMetrics): boolean {
  return (
    near(m.innerWidth, m.screenWidth) &&
    near(m.innerHeight, m.screenHeight) &&
    near(m.outerWidth, m.screenWidth) &&
    near(m.outerHeight, m.screenHeight) &&
    near(m.x, 0) &&
    near(m.y, 0)
  )
}

/**
 * One row per setting. With a bridge that measures the page itself, size,
 * scaling and fullscreen only affect the page layout, so a deviation is a
 * warning; without it they decide whether gaze can be placed at all.
 */
export function displayChecklist(
  metrics: DisplayMetrics,
  guard: Pick<DisplayGuardSnapshot, 'phase' | 'reasons' | 'required'>,
  native: Pick<NativeViewportState, 'capable' | 'connection'>,
  /** What the browser itself reports; page zoom makes the sizes disagree with it. */
  browserFullscreen = false,
): DisplayCheckRow[] {
  const deviation: DisplayCheckStatus = native.capable ? 'warn' : 'fail'
  const size = { w: EXPECTED_WIDTH, h: EXPECTED_HEIGHT }
  const rows: DisplayCheckRow[] = []

  rows.push({
    key: 'bridge',
    status:
      native.connection === 'connected' && native.capable
        ? 'ok'
        : native.connection === 'unreachable'
          ? 'fail'
          : native.connection === 'upgrade_required'
            ? 'warn'
            : 'info',
    current: { id: `bridge_${native.connection}` },
    expected: { id: 'bridge_expected' },
  })

  const scale = Number.isFinite(metrics.dpr) ? Math.round(metrics.dpr * 100) : 0
  const resolution =
    near(metrics.screenWidth, EXPECTED_WIDTH) && near(metrics.screenHeight, EXPECTED_HEIGHT)
  rows.push({
    key: 'resolution',
    status: resolution ? 'ok' : deviation,
    current: {
      id: resolution || near(metrics.dpr, 1, 0.001) ? 'size' : 'size_scaled',
      values: { w: metrics.screenWidth, h: metrics.screenHeight, value: scale },
    },
    expected: { id: 'size', values: size },
  })

  rows.push({
    key: 'scale',
    status: near(metrics.dpr, 1, 0.001) ? 'ok' : deviation,
    current: { id: 'percent', values: { value: scale } },
    expected: { id: 'percent', values: { value: 100 } },
  })

  const area =
    near(metrics.innerWidth, EXPECTED_WIDTH) && near(metrics.innerHeight, EXPECTED_HEIGHT)
  rows.push({
    key: 'browser_area',
    status: area ? 'ok' : deviation,
    current: { id: 'size', values: { w: metrics.innerWidth, h: metrics.innerHeight } },
    expected: { id: 'size', values: size },
  })

  const fullscreen = browserFullscreen || fillsScreen(metrics)
  rows.push({
    key: 'fullscreen',
    status: fullscreen ? 'ok' : deviation,
    current: { id: fullscreen ? 'yes' : 'no' },
    expected: { id: native.capable ? 'fullscreen_recommended' : 'yes' },
  })

  rows.push({
    key: 'displays',
    status: metrics.extended === true ? 'fail' : metrics.extended === false ? 'ok' : 'info',
    current: {
      id:
        metrics.extended === true
          ? 'displays_multiple'
          : metrics.extended === false
            ? 'displays_single'
            : 'unknown',
    },
    expected: { id: 'displays_single' },
  })

  const gesture =
    !!metrics.viewport &&
    (!near(metrics.viewport.scale, 1, 0.001) ||
      !near(metrics.viewport.x, 0, 0.01) ||
      !near(metrics.viewport.y, 0, 0.01))
  rows.push({
    key: 'zoom_gesture',
    status: gesture ? 'fail' : 'ok',
    current: { id: gesture ? 'yes' : 'no' },
    expected: { id: 'no' },
  })

  const foreground = metrics.visible && metrics.focused
  rows.push({
    key: 'foreground',
    // Only a measured page needs the focus; before it, this is just a reminder.
    status: foreground ? 'ok' : guard.required ? 'fail' : 'warn',
    current: { id: foreground ? 'yes' : 'no' },
    expected: { id: 'yes' },
  })

  const settling = guard.reasons.every(
    (reason) => reason === 'checking_display' || reason === 'confirmation_required',
  )
  const mapping =
    guard.phase === 'verified'
      ? { id: 'mapping_active', status: 'ok' as const }
      : guard.phase === 'ready'
        ? { id: 'mapping_ready', status: 'ok' as const }
        : guard.phase === 'suspended' || guard.phase === 'disabled'
          ? { id: 'mapping_paused', status: 'info' as const }
          : settling
            ? { id: 'mapping_checking', status: 'info' as const }
            : { id: 'mapping_waiting', status: 'fail' as const }
  rows.push({
    key: 'mapping',
    status: mapping.status,
    current: { id: mapping.id },
    expected: { id: 'mapping_active' },
  })

  return rows
}

/** The worst row decides the headline. */
export function displayCheckSummary(rows: DisplayCheckRow[]): 'ok' | 'warn' | 'fail' {
  if (rows.some((row) => row.status === 'fail')) return 'fail'
  if (rows.some((row) => row.status === 'warn')) return 'warn'
  return 'ok'
}
