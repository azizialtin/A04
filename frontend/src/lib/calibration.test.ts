import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CALIBRATION_TARGETS,
  VALIDATION_TARGETS,
  meanGaze,
  meanOffset,
  offsetInDegrees,
  offsetOf,
  toDisplay,
} from './calibration'

function stubWindow(over: Record<string, number>) {
  for (const [key, value] of Object.entries(over)) {
    vi.stubGlobal(key, value)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('toDisplay', () => {
  it('is the identity in fullscreen', () => {
    vi.stubGlobal('screen', { width: 2560, height: 1440 })
    stubWindow({ screenX: 0, screenY: 0, outerWidth: 2560, outerHeight: 1440, innerWidth: 2560, innerHeight: 1440 })
    expect(toDisplay({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 })
  })

  it('accounts for a window that is not the whole screen', () => {
    // A 1280x720 viewport at (640, 260), with 100px of chrome above it.
    vi.stubGlobal('screen', { width: 2560, height: 1440 })
    stubWindow({ screenX: 640, screenY: 260, outerWidth: 1280, outerHeight: 820, innerWidth: 1280, innerHeight: 720 })
    // Viewport centre is screen (640 + 640, 360 + 360) = (1280, 720) = dead centre.
    expect(toDisplay({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 })
    expect(toDisplay({ x: 0, y: 0 })).toEqual({ x: 640 / 2560, y: 360 / 1440 })
  })
})

describe('meanGaze', () => {
  it('averages the valid samples', () => {
    const at = meanGaze([
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.6 },
      { x: null, y: null },
    ])
    expect(at).toEqual({ x: 0.5, y: 0.5 })
  })

  it('is null when the participant blinked through the whole target', () => {
    expect(meanGaze([{ x: null, y: null }])).toBeNull()
    expect(meanGaze([])).toBeNull()
  })
})

describe('offsetOf', () => {
  it('measures both axes against screen width', () => {
    // 0.1 of width horizontally.
    expect(offsetOf({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, 16 / 9)).toBeCloseTo(0.1, 6)
    // 0.1 of *height* vertically is a smaller physical distance on a 16:9 screen.
    expect(offsetOf({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 }, 16 / 9)).toBeCloseTo(0.05625, 6)
  })
})

describe('meanOffset', () => {
  it('ignores targets with no valid gaze', () => {
    const base = { target_x: 0, target_y: 0, gaze_x: null, gaze_y: null, samples: 0 }
    expect(meanOffset([{ ...base, offset: 0.02 }, { ...base, offset: 0.04 }, { ...base, offset: null }])).toBeCloseTo(0.03)
  })

  it('is null when nothing was measured', () => {
    expect(meanOffset([])).toBeNull()
  })
})

describe('offsetInDegrees', () => {
  it('converts once the screen size and viewing distance are known', () => {
    // 2% of a 530mm screen is 10.6mm, seen from 600mm ≈ 1.01°.
    expect(offsetInDegrees(0.02, 530, 600)).toBeCloseTo(1.012, 2)
  })

  it('refuses to guess without them', () => {
    expect(offsetInDegrees(0.02, null, 600)).toBeNull()
    expect(offsetInDegrees(0.02, 530, null)).toBeNull()
    expect(offsetInDegrees(null, 530, 600)).toBeNull()
  })
})

describe('targets', () => {
  it('validates on points it did not calibrate on', () => {
    const calibrated = new Set(CALIBRATION_TARGETS.map((p) => `${p.x},${p.y}`))
    expect(VALIDATION_TARGETS.some((p) => calibrated.has(`${p.x},${p.y}`))).toBe(false)
  })

  it('keeps every target on screen', () => {
    for (const p of [...CALIBRATION_TARGETS, ...VALIDATION_TARGETS]) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(1)
    }
  })
})
