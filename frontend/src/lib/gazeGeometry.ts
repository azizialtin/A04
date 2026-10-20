// Where the clip sits on the physical screen. The tracker reports gaze against
// the whole display, so without this a sample cannot be placed on the video —
// not during the replay, and not afterwards from the archived data either.

export interface GazeGeometry {
  ts: number
  screen: { w: number; h: number; is_extended?: boolean }
  window: {
    x: number
    y: number
    outer_w: number
    outer_h: number
    inner_w: number
    inner_h: number
  }
  video: { x: number; y: number; w: number; h: number }
  frame: { w: number; h: number }
  dpr: number
  visual_viewport?: { scale: number; x: number; y: number; w: number; h: number }
}

export interface GazeAoi {
  id: string
  x: number
  y: number
  w: number
  h: number
  priority: number
}

export type GazeLayout = Omit<GazeGeometry, 'video' | 'frame'> & {
  video?: GazeGeometry['video']
  frame?: GazeGeometry['frame']
  aois?: GazeAoi[]
  active_modal?: string | null
  visible?: boolean
}

/**
 * Snapshot the current layout, or null while it is not yet measurable — the
 * element is unmounted, laid out at zero size, or has not loaded its metadata.
 * Holding out for a complete snapshot keeps every stored geometry usable.
 */
export function captureGeometry(el: HTMLVideoElement | null): GazeGeometry | null {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height || !el.videoWidth || !el.videoHeight) return null

  return {
    ts: Date.now(),
    screen: { w: window.screen.width, h: window.screen.height },
    window: {
      x: window.screenX,
      y: window.screenY,
      outer_w: window.outerWidth,
      outer_h: window.outerHeight,
      inner_w: window.innerWidth,
      inner_h: window.innerHeight,
    },
    video: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    frame: { w: el.videoWidth, h: el.videoHeight },
    dpr: window.devicePixelRatio || 1,
  }
}

/** Same layout, ignoring when it was measured. */
export function sameLayout(a: GazeLayout | null, b: GazeLayout | null): boolean {
  if (!a || !b) return false
  return JSON.stringify({ ...a, ts: 0 }) === JSON.stringify({ ...b, ts: 0 })
}

/**
 * Where a frame-normalised point lands inside an element showing the clip with
 * `object-fit: contain`, in element pixels. Undoes the letterbox the same way
 * the backend does when mapping the samples in.
 */
export function frameToElement(
  point: { x: number; y: number },
  box: { width: number; height: number },
  frame: { width: number; height: number },
): { left: number; top: number } {
  const fits = frame.width > 0 && frame.height > 0
  const scale = fits ? Math.min(box.width / frame.width, box.height / frame.height) : 1
  const contentW = fits ? frame.width * scale : box.width
  const contentH = fits ? frame.height * scale : box.height
  return {
    left: (box.width - contentW) / 2 + point.x * contentW,
    top: (box.height - contentH) / 2 + point.y * contentH,
  }
}
