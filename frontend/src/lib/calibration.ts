// Calibration and validation geometry. Targets are held in viewport fractions
// because that is how they are drawn; the tracker wants display fractions, so
// everything crossing the bridge goes through toDisplay().

export interface Target {
  x: number
  y: number
}

export interface ValidationPoint {
  target_x: number
  target_y: number
  gaze_x: number | null
  gaze_y: number | null
  offset: number | null
  samples: number
}

/** Five points: centre first so the participant settles, then the corners. */
export const CALIBRATION_TARGETS: Target[] = [
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.9 },
  { x: 0.9, y: 0.9 },
]

/** Four points, deliberately not the ones just calibrated on. */
export const VALIDATION_TARGETS: Target[] = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.25, y: 0.75 },
  { x: 0.75, y: 0.75 },
]

/**
 * A point in the viewport as a fraction of the whole display. Exact in
 * fullscreen; otherwise it accounts for where the window sits, assuming the
 * browser's chrome is above the viewport with symmetric side borders — the
 * same assumption the backend makes when mapping samples the other way.
 */
export function toDisplay(target: Target): Target {
  const screenW = window.screen.width || window.innerWidth
  const screenH = window.screen.height || window.innerHeight
  const originX = window.screenX + (window.outerWidth - window.innerWidth) / 2
  const originY = window.screenY + (window.outerHeight - window.innerHeight)
  return {
    x: (originX + target.x * window.innerWidth) / screenW,
    y: (originY + target.y * window.innerHeight) / screenH,
  }
}

/** Mean of the valid samples collected while a target was showing. */
export function meanGaze(
  samples: { x: number | null; y: number | null }[],
): { x: number; y: number } | null {
  const valid = samples.filter(
    (s): s is { x: number; y: number } => typeof s.x === 'number' && typeof s.y === 'number',
  )
  if (!valid.length) return null
  return {
    x: valid.reduce((sum, s) => sum + s.x, 0) / valid.length,
    y: valid.reduce((sum, s) => sum + s.y, 0) / valid.length,
  }
}

/**
 * Offset between a target and the measured gaze, as a fraction of screen width.
 * Both axes are scaled by width so the number stays isotropic — a y fraction on
 * a 16:9 screen covers fewer millimetres than the same x fraction.
 */
export function offsetOf(target: Target, gaze: Target, aspect: number): number {
  const dx = gaze.x - target.x
  const dy = (gaze.y - target.y) / aspect
  return Math.sqrt(dx * dx + dy * dy)
}

export function meanOffset(points: ValidationPoint[]): number | null {
  const offsets = points.map((p) => p.offset).filter((o): o is number => o !== null)
  if (!offsets.length) return null
  return offsets.reduce((sum, o) => sum + o, 0) / offsets.length
}

/**
 * The same offset in degrees of visual angle, once the physical screen width
 * and the participant's distance from it are known. Returns null without them —
 * a fabricated degree figure would be worse than none.
 */
export function offsetInDegrees(
  offset: number | null,
  screenWidthMm: number | null,
  distanceMm: number | null,
): number | null {
  if (offset === null || !screenWidthMm || !distanceMm) return null
  return (Math.atan2(offset * screenWidthMm, distanceMm) * 180) / Math.PI
}
