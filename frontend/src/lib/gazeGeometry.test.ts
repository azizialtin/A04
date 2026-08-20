import { describe, expect, it } from 'vitest'

import { captureGeometry, frameToElement, sameLayout } from './gazeGeometry'

function fakeVideo(over: Partial<{ w: number; h: number; vw: number; vh: number }> = {}) {
  const { w = 640, h = 360, vw = 1920, vh = 1080 } = over
  return {
    getBoundingClientRect: () => ({ x: 10, y: 20, width: w, height: h }),
    videoWidth: vw,
    videoHeight: vh,
  } as unknown as HTMLVideoElement
}

describe('captureGeometry', () => {
  it('reads the element box and the frame size', () => {
    const geo = captureGeometry(fakeVideo())!
    expect(geo.video).toEqual({ x: 10, y: 20, w: 640, h: 360 })
    expect(geo.frame).toEqual({ w: 1920, h: 1080 })
    expect(geo.ts).toBeGreaterThan(0)
  })

  it('holds out until the layout is measurable', () => {
    expect(captureGeometry(null)).toBeNull()
    expect(captureGeometry(fakeVideo({ w: 0 }))).toBeNull()
    expect(captureGeometry(fakeVideo({ vw: 0, vh: 0 }))).toBeNull()
  })
})

describe('sameLayout', () => {
  it('ignores when the snapshot was taken', () => {
    const a = captureGeometry(fakeVideo())!
    expect(sameLayout(a, { ...a, ts: a.ts + 5000 })).toBe(true)
  })

  it('sees a moved element', () => {
    const a = captureGeometry(fakeVideo())!
    expect(sameLayout(a, { ...a, video: { ...a.video, x: 11 } })).toBe(false)
  })

  it('treats a missing snapshot as different', () => {
    expect(sameLayout(null, captureGeometry(fakeVideo()))).toBe(false)
  })
})

describe('frameToElement', () => {
  const box = { width: 800, height: 600 }

  it('centres a point in the picture', () => {
    const at = frameToElement({ x: 0.5, y: 0.5 }, box, { width: 1600, height: 900 })
    expect(at).toEqual({ left: 400, top: 300 })
  })

  it('offsets past the letterbox bars', () => {
    // 16:9 inside 4:3 leaves 800x450 of picture, so 75px bars top and bottom.
    const frame = { width: 1600, height: 900 }
    expect(frameToElement({ x: 0, y: 0 }, box, frame)).toEqual({ left: 0, top: 75 })
    expect(frameToElement({ x: 1, y: 1 }, box, frame)).toEqual({ left: 800, top: 525 })
  })

  it('offsets past pillarbox bars', () => {
    // 1:1 inside 4:3 leaves 600x600 of picture, so 100px bars left and right.
    const frame = { width: 1000, height: 1000 }
    expect(frameToElement({ x: 0, y: 0 }, box, frame)).toEqual({ left: 100, top: 0 })
    expect(frameToElement({ x: 1, y: 0.5 }, box, frame)).toEqual({ left: 700, top: 300 })
  })

  it('falls back to the element box when the frame size is unknown', () => {
    expect(frameToElement({ x: 0.5, y: 0.5 }, box, { width: 0, height: 0 })).toEqual({
      left: 400,
      top: 300,
    })
  })
})
