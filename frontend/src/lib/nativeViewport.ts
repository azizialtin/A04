import { TOBII_WS_URL } from './tobii'
import { requestBridgePermission } from './bridgePermission'

export const NATIVE_VIEWPORT_PROFILE = 'native_viewport_v1' as const
export const NATIVE_VIEWPORT_TTL_MS = 500
export const NATIVE_SAMPLE_MAX_AGE_MS = 50

export type NativeBridgeConnection =
  'idle' | 'connecting' | 'permission_pending' | 'connected' | 'unreachable' | 'upgrade_required'

type Box = { x: number; y: number; w: number; h: number }
export interface NativeViewport {
  id: string
  tab_id: string
  display: Box
  content: Box
  css: { w: number; h: number }
  dpr: number
}
export interface NativeViewportState {
  owner: string | null
  capable: boolean
  tabId: string | null
  proof: NativeViewport | null
  errorCode: string | null
  connection: NativeBridgeConnection
}

export interface BrowserViewport {
  w: number
  h: number
  dpr: number
  focused: boolean
  visible: boolean
  scale: number
  offsetX: number
  offsetY: number
  extended: boolean
  fingerprint: string
}
export function readBrowserViewport(): BrowserViewport {
  const v = window.visualViewport
  const values = {
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
    focused: document.hasFocus(),
    visible: document.visibilityState !== 'hidden',
    scale: v?.scale ?? 1,
    offsetX: v?.offsetLeft ?? 0,
    offsetY: v?.offsetTop ?? 0,
    extended: (window.screen as Screen & { isExtended?: boolean }).isExtended === true,
  }
  return {
    ...values,
    fingerprint: JSON.stringify([
      values,
      window.screenX,
      window.screenY,
      window.outerWidth,
      window.outerHeight,
      window.screen.width,
      window.screen.height,
    ]),
  }
}

export function browserViewportProblem(v: BrowserViewport): string | null {
  if (!v.focused || !v.visible) return 'window_focus'
  if (v.extended) return 'multiple_displays'
  if (v.scale !== 1 || v.offsetX !== 0 || v.offsetY !== 0) return 'viewport_zoom'
  if (![v.w, v.h, v.dpr].every((n) => Number.isFinite(n) && n > 0)) return 'invalid_dimensions'
  return null
}

/** Verify physical content bounds against the exact CSS viewport that requested them. */
export function parseNativeViewport(
  value: unknown,
  tabId: string,
  css: BrowserViewport,
): NativeViewport | null {
  if (!value || typeof value !== 'object') return null
  const p = value as NativeViewport
  const box = (b: Box) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0
  if (
    typeof p.id !== 'string' ||
    !p.id ||
    p.id.length > 128 ||
    p.tab_id !== tabId ||
    !box(p.display) ||
    !box(p.content) ||
    !p.css ||
    p.css.w !== css.w ||
    p.css.h !== css.h ||
    p.dpr !== css.dpr ||
    Math.abs(p.content.w - css.w * css.dpr) > 2 ||
    Math.abs(p.content.h - css.h * css.dpr) > 2
  )
    return null
  if (
    p.content.x < p.display.x ||
    p.content.y < p.display.y ||
    p.content.x + p.content.w > p.display.x + p.display.w ||
    p.content.y + p.content.h > p.display.y + p.display.h
  )
    return null
  // Copy only contract fields; no provider diagnostics or arbitrary payload reaches exports.
  return {
    id: p.id,
    tab_id: tabId,
    display: { x: p.display.x, y: p.display.y, w: p.display.w, h: p.display.h },
    content: { x: p.content.x, y: p.content.y, w: p.content.w, h: p.content.h },
    css: { w: p.css.w, h: p.css.h },
    dpr: p.dpr,
  }
}

/** One lease per participant tab, independent of individual page recorders. */
export class NativeViewportController {
  private snapshot: NativeViewportState = {
    owner: null,
    capable: false,
    tabId: null,
    proof: null,
    errorCode: null,
    connection: 'idle',
  }
  private listeners = new Set<() => void>()
  private active = false
  private socket: WebSocket | null = null
  private timer = 0
  private retryTimer = 0
  private handshakeTimer = 0
  private permissionTimer = 0
  private permissionAttempt: AbortController | null = null
  private pending: { id: string; sent: number; fingerprint: string } | null = null
  private observedAt = 0
  private receivedAt = 0
  private proofFingerprint = ''
  private originalTitle = ''
  private marker = ''
  private handshake = false
  constructor(
    private read = readBrowserViewport,
    private now = Date.now,
    private monotonic = () => performance.now(),
    private makeSocket = (url: string) => new WebSocket(url),
    private requestPermission = requestBridgePermission,
  ) {}

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(value: Partial<NativeViewportState>) {
    const next = { ...this.snapshot, ...value }
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
    this.snapshot = next
    this.listeners.forEach((listener) => listener())
  }
  private nonce() {
    return crypto.randomUUID().replace(/-/g, '')
  }
  private setTitle() {
    if (!this.marker || document.title.includes(this.marker)) return
    this.originalTitle = document.title
    document.title = `${this.originalTitle} ${this.marker}`.trim()
  }
  private restoreTitle() {
    if (this.marker && document.title.includes(this.marker))
      document.title = document.title.replace(this.marker, '').trim()
  }
  configure(owner: string | null, active: boolean) {
    if (owner !== this.snapshot.owner) {
      this.stop()
      this.publish({
        owner,
        capable: false,
        tabId: owner ? this.nonce() : null,
        proof: null,
        errorCode: null,
        connection: 'idle',
      })
      this.marker = this.snapshot.tabId ? `[A04:${this.snapshot.tabId}]` : ''
      this.active = active && !!owner
      if (owner) {
        this.connect()
        this.timer = window.setInterval(this.tick, 125)
      }
    } else {
      this.active = active && !!owner
      if (!this.active) {
        this.invalidate('suspended')
        this.restoreTitle()
      }
      this.tick()
    }
  }
  release(owner: string) {
    if (this.snapshot.owner === owner) this.configure(null, false)
  }
  /** User-initiated permission recovery changes only the mapping connection. */
  retry = () => {
    if (!this.snapshot.owner) return
    this.cancelPermission()
    this.closeSocket()
    this.invalidate('checking_display')
    const attempt = new AbortController()
    this.permissionAttempt = attempt
    this.publish({ connection: 'permission_pending' })
    const finish = () => {
      if (this.permissionAttempt !== attempt) return
      window.clearTimeout(this.permissionTimer)
      this.permissionAttempt = null
      // This is a permission trigger, not a health check. Only the subsequent
      // correlated bridge handshake and measurement may verify gaze geometry.
      attempt.abort()
      this.connect()
    }
    this.permissionTimer = window.setTimeout(finish, 90_000)
    try {
      // Keep the fetch within the click's user activation, before any await.
      void this.requestPermission(attempt.signal).then(finish, finish)
    } catch {
      finish()
    }
  }
  invalidate = (reason = 'checking_display') => {
    this.pending = null
    this.observedAt = this.receivedAt = 0
    this.proofFingerprint = ''
    this.publish({ proof: null, errorCode: reason })
  }
  private stop() {
    window.clearInterval(this.timer)
    this.cancelPermission()
    this.closeSocket()
    this.restoreTitle()
    this.observedAt = this.receivedAt = 0
  }
  private cancelPermission() {
    window.clearTimeout(this.permissionTimer)
    const old = this.permissionAttempt
    this.permissionAttempt = null
    old?.abort()
  }
  private closeSocket() {
    window.clearTimeout(this.retryTimer)
    window.clearTimeout(this.handshakeTimer)
    this.pending = null
    this.handshake = false
    const old = this.socket
    this.socket = null
    if (old) {
      old.onmessage = old.onerror = old.onclose = null
      old.close()
    }
  }
  private connect = () => {
    if (!this.snapshot.owner) return
    this.publish({ connection: 'connecting', errorCode: 'checking_display' })
    let ws: WebSocket
    try {
      ws = this.makeSocket(TOBII_WS_URL)
    } catch {
      this.reconnect()
      return
    }
    this.socket = ws
    this.handshake = false
    this.handshakeTimer = window.setTimeout(() => {
      if (this.socket === ws && !this.handshake) this.reconnect()
    }, 5000)
    ws.onerror = ws.onclose = () => {
      if (this.socket === ws) this.reconnect()
    }
    ws.onmessage = (event) => {
      if (this.socket !== ws) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'status') {
        window.clearTimeout(this.handshakeTimer)
        this.handshake = true
        // Once native support is seen it cannot silently downgrade after a disconnect.
        if (msg.native_viewport === true) {
          this.publish({ capable: true, connection: 'connected', errorCode: 'checking_display' })
        } else {
          this.publish({ connection: 'upgrade_required' })
          this.invalidate('bridge_upgrade_required')
        }
        this.tick()
        return
      }
      if (
        msg.type !== 'viewport_status' ||
        !this.pending ||
        msg.request_id !== this.pending.id ||
        msg.tab_id !== this.snapshot.tabId
      )
        return
      const pending = this.pending
      this.pending = null
      const css = this.read()
      if (!this.active || browserViewportProblem(css) || css.fingerprint !== pending.fingerprint) {
        this.invalidate('checking_display')
        return
      }
      const observed = msg.observed_at
      if (
        typeof observed !== 'number' ||
        !Number.isFinite(observed) ||
        observed < pending.sent - 50 ||
        observed > this.now() + 50 ||
        this.now() - pending.sent > NATIVE_VIEWPORT_TTL_MS
      ) {
        this.invalidate('stale_measurement')
        return
      }
      const proof =
        msg.ok === true && this.snapshot.tabId
          ? parseNativeViewport(msg.native_viewport, this.snapshot.tabId, css)
          : null
      if (!proof) {
        this.invalidate(
          typeof msg.error_code === 'string' && /^[a-z_]{1,64}$/.test(msg.error_code)
            ? msg.error_code
            : 'invalid_measurement',
        )
        return
      }
      this.observedAt = observed
      this.receivedAt = this.monotonic()
      this.proofFingerprint = css.fingerprint
      this.publish({ proof, errorCode: null })
    }
  }
  private reconnect() {
    window.clearTimeout(this.handshakeTimer)
    const old = this.socket
    this.socket = null
    this.handshake = false
    if (old) {
      old.onmessage = old.onerror = old.onclose = null
      old.close()
    }
    this.invalidate('bridge_unreachable')
    this.publish({ connection: 'unreachable' })
    window.clearTimeout(this.retryTimer)
    if (this.snapshot.owner) this.retryTimer = window.setTimeout(this.connect, 2000)
  }
  private tick = () => {
    if (
      !this.active ||
      !this.snapshot.capable ||
      !this.handshake ||
      this.snapshot.connection !== 'connected'
    )
      return
    this.setTitle()
    const css = this.read()
    const issue = browserViewportProblem(css)
    if (issue) {
      this.invalidate(issue)
      return
    }
    if (this.snapshot.proof && !this.current()) this.invalidate('stale_measurement')
    if (this.pending && this.now() - this.pending.sent < 350) return
    const id = this.nonce()
    this.pending = { id, sent: this.now(), fingerprint: css.fingerprint }
    try {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      this.socket.send(
        JSON.stringify({
          type: 'viewport_probe',
          request_id: id,
          tab_id: this.snapshot.tabId,
          css: { w: css.w, h: css.h },
          dpr: css.dpr,
        }),
      )
    } catch {
      this.reconnect()
    }
  }
  current = (): NativeViewport | null => {
    const css = this.read()
    if (
      !this.active ||
      !this.snapshot.proof ||
      browserViewportProblem(css) ||
      css.fingerprint !== this.proofFingerprint ||
      this.monotonic() - this.receivedAt > NATIVE_VIEWPORT_TTL_MS ||
      this.now() - this.observedAt > NATIVE_VIEWPORT_TTL_MS ||
      this.observedAt > this.now() + 50
    )
      return null
    return this.snapshot.proof
  }
}

export const nativeViewport = new NativeViewportController()
export const getNativeViewportSnapshot = nativeViewport.getSnapshot
export const subscribeNativeViewport = nativeViewport.subscribe
export const currentNativeViewport = nativeViewport.current
export function nativeGazeLease() {
  const state = getNativeViewportSnapshot()
  return state.capable && state.tabId ? { tab_id: state.tabId } : {}
}
export function nativeSampleMatches(sample: Record<string, unknown>, proof: NativeViewport | null) {
  return (
    !!proof &&
    sample.viewport_id === proof.id &&
    typeof sample.viewport_ts === 'number' &&
    Number.isFinite(sample.viewport_ts) &&
    typeof sample.ts === 'number' &&
    Number.isFinite(sample.ts) &&
    Math.abs(sample.ts - sample.viewport_ts) <= NATIVE_SAMPLE_MAX_AGE_MS
  )
}
