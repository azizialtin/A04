import { captureGeometry, type GazeAoi, type GazeLayout } from './gazeGeometry'

type Box = { x: number; y: number; w: number; h: number }

/** The app's fixed notifications and modal backdrops can share a z-index. */
function stackingLayers(el: Element): { element: Element; z: number }[] {
  const layers = []
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    const positioned = /^(fixed|sticky|absolute|relative)$/.test(style.position)
    const explicitZ = style.zIndex !== '' && style.zIndex !== 'auto'
    const transformed = style.transform !== '' && style.transform !== 'none'
    const transparent = style.opacity !== '' && Number(style.opacity) < 1
    if (
      (positioned && explicitZ) ||
      /^(fixed|sticky)$/.test(style.position) ||
      transformed ||
      transparent ||
      style.isolation === 'isolate'
    ) {
      layers.unshift({ element: node, z: explicitZ ? Number(style.zIndex) || 0 : 0 })
    }
  }
  return layers
}

function paintsAbove(overlay: Element, modal: Element): boolean {
  if (modal.contains(overlay)) return true
  const overlays = stackingLayers(overlay)
  const modals = stackingLayers(modal)
  let i = 0
  while (overlays[i] && modals[i] && overlays[i].element === modals[i].element) i++
  const a = overlays[i] ?? { element: overlay, z: 0 }
  const b = modals[i] ?? { element: modal, z: 0 }
  if (a.z !== b.z) return a.z > b.z
  return !!(b.element.compareDocumentPosition(a.element) & Node.DOCUMENT_POSITION_FOLLOWING)
}

function visible(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false
    }
  }
  return true
}

/** Only the part actually on screen counts, including clipping by scrollable parents. */
export function visibleBox(el: Element): Box | null {
  if (!visible(el)) return null
  const rect = el.getBoundingClientRect()
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(window.innerWidth, rect.right)
  let bottom = Math.min(window.innerHeight, rect.bottom)
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    const clips = (value: string) => /^(auto|scroll|hidden|clip)$/.test(value)
    if (!clips(style.overflowX) && !clips(style.overflowY)) continue
    const box = node.getBoundingClientRect()
    if (clips(style.overflowX)) {
      left = Math.max(left, box.left + node.clientLeft)
      right = Math.min(right, box.left + node.clientLeft + node.clientWidth)
    }
    if (clips(style.overflowY)) {
      top = Math.max(top, box.top + node.clientTop)
      bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight)
    }
  }
  // Matrix answers scroll beneath their sticky row prompt; only the exposed
  // part is an answer AOI, even while the cell's DOM rectangle still overlaps.
  if (el.getAttribute('data-aoi-clip') === 'after-row-prompt') {
    const prompt = el.closest('tr')?.querySelector('[data-aoi-row-prompt]')
    const cover = prompt ? visibleBox(prompt) : null
    if (cover && bottom > cover.y && top < cover.y + cover.h) {
      left = Math.max(left, cover.x + cover.w)
    }
  }
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null
}

export function capturePageGeometry(): GazeLayout {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
  const shownDialogs = dialogs.filter((el) => visibleBox(el))
  const modal = shownDialogs[shownDialogs.length - 1]
  const root = modal ?? document
  const elements = [...root.querySelectorAll<HTMLElement>('[data-aoi]')]
  if (modal?.hasAttribute('data-aoi')) elements.unshift(modal)
  // A full-screen modal backdrop covers notifications below it, even outside
  // the inner dialog. Equal-priority notices are ordered by their painted stack.
  const overlays = [
    ...document.querySelectorAll<HTMLElement>('[data-aoi][data-aoi-overlay="true"]'),
  ]
    .filter((el) => !modal || paintsAbove(el, modal))
    .sort((a, b) => (paintsAbove(a, b) ? 1 : -1))
  const ordered = [...elements.filter((el) => el.dataset.aoiOverlay !== 'true'), ...overlays]
  const aois: GazeAoi[] = [...new Set(ordered)].flatMap((el) => {
    const box = visibleBox(el)
    const id = el.dataset.aoi
    if (!box || !id) return []
    return [{ id, ...box, priority: Number(el.dataset.aoiPriority) || 0 }]
  })
  const video = document.querySelector<HTMLVideoElement>('video[data-gaze-video]')
  const clip = captureGeometry(video)
  const viewport = window.visualViewport
  const isExtended = (window.screen as Screen & { isExtended?: boolean }).isExtended
  return {
    ts: Date.now(),
    screen: {
      w: window.screen.width,
      h: window.screen.height,
      ...(typeof isExtended === 'boolean' ? { is_extended: isExtended } : {}),
    },
    window: {
      x: window.screenX,
      y: window.screenY,
      outer_w: window.outerWidth,
      outer_h: window.outerHeight,
      inner_w: window.innerWidth,
      inner_h: window.innerHeight,
    },
    dpr: window.devicePixelRatio || 1,
    ...(viewport
      ? {
          visual_viewport: {
            scale: viewport.scale,
            x: viewport.offsetLeft,
            y: viewport.offsetTop,
            w: viewport.width,
            h: viewport.height,
          },
        }
      : {}),
    ...(clip ? { video: clip.video, frame: clip.frame } : {}),
    aois,
    active_modal: modal ? modal.dataset.aoiModal || 'dialog' : null,
    visible: document.visibilityState !== 'hidden' && document.hasFocus(),
  }
}

/** Observe layout, not the participant's text or answer values. */
export function observePageGeometry(onChange: () => void): () => void {
  let frame = 0
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        onChange()
      })
    }
  }
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
  const observeElements = () => {
    resize?.disconnect()
    resize?.observe(document.documentElement)
    document.querySelectorAll('[data-aoi]').forEach((el) => resize?.observe(el))
  }
  const mutation = new MutationObserver((records) => {
    if (records.some((record) => record.type === 'childList')) observeElements()
    schedule()
  })
  mutation.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'class',
      'style',
      'hidden',
      'open',
      'data-aoi',
      'aria-modal',
      'data-aoi-clip',
      'data-aoi-row-prompt',
      'data-aoi-priority',
      'data-aoi-overlay',
    ],
  })
  observeElements()
  document.addEventListener('scroll', schedule, true)
  document.addEventListener('input', schedule, true)
  document.addEventListener('visibilitychange', onChange)
  window.addEventListener('resize', schedule)
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  window.visualViewport?.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('scroll', schedule)
  // Moving a browser window does not emit a resize event.
  const timer = window.setInterval(schedule, 1000)
  schedule()
  return () => {
    cancelAnimationFrame(frame)
    clearInterval(timer)
    mutation.disconnect()
    resize?.disconnect()
    document.removeEventListener('scroll', schedule, true)
    document.removeEventListener('input', schedule, true)
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
    window.visualViewport?.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('scroll', schedule)
  }
}
