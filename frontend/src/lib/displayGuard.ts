import {
  currentNativeViewport,
  getNativeViewportSnapshot,
  NATIVE_VIEWPORT_PROFILE,
  type NativeViewport,
} from './nativeViewport'

export const DISPLAY_GUARD_ENABLED =
  import.meta.env.MODE === 'lab' || import.meta.env.VITE_LAB_DISPLAY_GUARD === 'true'
/**
 * Whether an unverified display stops the participant. Off by default: the
 * display is checked, shown and recorded, and gaze taken on an unverified
 * display stays out of the AOI evaluation, but the task itself is never held.
 * `VITE_LAB_DISPLAY_GUARD_BLOCKING=true` restores the blocking dialog with its
 * explicit study-lead confirmation.
 */
export const DISPLAY_GUARD_BLOCKING = import.meta.env.VITE_LAB_DISPLAY_GUARD_BLOCKING === 'true'
export const DISPLAY_GUARD_PROFILE = 'lab_1080p' as const
export const DISPLAY_STABLE_MS = 500

export type DisplayGuardProfile = typeof DISPLAY_GUARD_PROFILE | typeof NATIVE_VIEWPORT_PROFILE

export type DisplayGuardScope = 'required' | 'monitor' | 'suspended'

export type DisplayGuardReason =
  | 'confirmation_required'
  | 'checking_display'
  | 'screen_resolution'
  | 'window_size'
  | 'window_position'
  | 'display_scale'
  | 'viewport_zoom'
  | 'multiple_displays'
  | 'window_focus'
  | 'clock_changed'
  | 'native_measurement'

export interface DisplayMetrics {
  screenWidth: number
  screenHeight: number
  innerWidth: number
  innerHeight: number
  outerWidth: number
  outerHeight: number
  x: number
  y: number
  dpr: number
  extended?: boolean
  visible: boolean
  focused: boolean
  viewport?: { scale: number; x: number; y: number }
}

export interface DisplayGuardSnapshot {
  enabled: boolean
  profile?: DisplayGuardProfile
  phase: 'disabled' | 'suspended' | 'blocked' | 'ready' | 'verified'
  owner: string | null
  required: boolean
  focusRequired: boolean
  /** False when the guard only observes. Absent means blocking, as before the flag existed. */
  blocking?: boolean
  /** Researcher-approved task access; never certifies gaze geometry. */
  unverifiedContinuation: boolean
  reasons: DisplayGuardReason[]
  generation: number
}

export interface DisplayGuardEvent {
  event_type:
    'display_guard_interrupted' | 'display_guard_resumed' | 'display_guard_continued_unverified'
  client_ts: number
  payload: {
    profile: DisplayGuardProfile
    detected_at: number
    reasons: DisplayGuardReason[]
  }
}

export function displayProblems(metrics: DisplayMetrics, focusRequired: boolean) {
  const reasons: DisplayGuardReason[] = []
  const near = (value: number, expected: number, tolerance = 1) =>
    Number.isFinite(value) && Math.abs(value - expected) <= tolerance
  if (!near(metrics.screenWidth, 1920) || !near(metrics.screenHeight, 1080))
    reasons.push('screen_resolution')
  if (
    !near(metrics.innerWidth, 1920) ||
    !near(metrics.innerHeight, 1080) ||
    !near(metrics.outerWidth, 1920) ||
    !near(metrics.outerHeight, 1080)
  )
    reasons.push('window_size')
  if (!near(metrics.x, 0) || !near(metrics.y, 0)) reasons.push('window_position')
  if (!near(metrics.dpr, 1, 0.001)) reasons.push('display_scale')
  if (
    metrics.viewport &&
    (!near(metrics.viewport.scale, 1, 0.001) ||
      !near(metrics.viewport.x, 0, 0.01) ||
      !near(metrics.viewport.y, 0, 0.01))
  )
    reasons.push('viewport_zoom')
  if (metrics.extended === true) reasons.push('multiple_displays')
  if (focusRequired && (!metrics.visible || !metrics.focused)) reasons.push('window_focus')
  return reasons
}

export function readDisplayMetrics(): DisplayMetrics {
  const viewport = window.visualViewport
  return {
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    x: window.screenX,
    y: window.screenY,
    dpr: window.devicePixelRatio,
    extended: (window.screen as Screen & { isExtended?: boolean }).isExtended,
    visible: document.visibilityState !== 'hidden',
    focused: document.hasFocus(),
    ...(viewport
      ? { viewport: { scale: viewport.scale, x: viewport.offsetLeft, y: viewport.offsetTop } }
      : {}),
  }
}

/** Owns verification across page changes; valid dimensions alone never resume a task. */
export class DisplayGuardController {
  private snapshot: DisplayGuardSnapshot
  private scope: DisplayGuardScope = 'suspended'
  private suspendedAt: number | null = null
  private listeners = new Set<() => void>()
  private stableSince: number | null = null
  private lastObserved: number | null = null
  private largestTimestamp = 0
  private verifiedAt = Infinity
  private verifiedObservations: number[] = []
  private interruptedFrom: number | null = null
  private nativeConfirmed = false
  private nativeGeometryId: string | null = null
  private sink: (event: DisplayGuardEvent) => void = () => {}

  constructor(
    enabled: boolean,
    private read = readDisplayMetrics,
    private wallTime = Date.now,
    private monotonicTime = () => performance.now(),
    private native = (): {
      capable: boolean
      proof: NativeViewport | null
      /** A bridge connection is being opened and has not yet said what it can do. */
      pending?: boolean
    } => ({
      capable: getNativeViewportSnapshot().capable,
      proof: currentNativeViewport(),
      pending: ['connecting', 'permission_pending'].includes(
        getNativeViewportSnapshot().connection,
      ),
    }),
    private blocking = true,
  ) {
    this.snapshot = {
      enabled,
      blocking,
      profile: DISPLAY_GUARD_PROFILE,
      phase: enabled ? 'blocked' : 'disabled',
      owner: null,
      required: false,
      focusRequired: false,
      unverifiedContinuation: false,
      reasons: enabled ? [this.pendingReason()] : [],
      generation: 0,
    }
  }

  /** What an otherwise correct display still waits for before it is verified. */
  private pendingReason(): DisplayGuardReason {
    return this.blocking ? 'confirmation_required' : 'checking_display'
  }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(next: Partial<DisplayGuardSnapshot>) {
    const value = { ...this.snapshot, ...next }
    if (JSON.stringify(value) === JSON.stringify(this.snapshot)) return
    this.snapshot = value
    this.listeners.forEach((listener) => listener())
  }

  private event(
    event_type: DisplayGuardEvent['event_type'],
    timestamp: number,
    reasons: DisplayGuardReason[],
  ) {
    if (!this.snapshot.owner) return
    this.sink({
      event_type,
      client_ts: Math.max(0, Math.floor(timestamp)),
      payload: {
        profile: this.snapshot.profile ?? DISPLAY_GUARD_PROFILE,
        detected_at: this.wallTime(),
        reasons,
      },
    })
  }

  configure(
    owner: string | null,
    scope: DisplayGuardScope,
    sink?: (event: DisplayGuardEvent) => void,
  ) {
    if (!this.snapshot.enabled) return
    if (sink) this.sink = sink
    const changedOwner = owner !== this.snapshot.owner
    const unverifiedContinuation = !changedOwner && this.snapshot.unverifiedContinuation
    const previousScope = this.scope
    const required = scope === 'required'
    const focusRequired = required
    const entering = required && (previousScope !== 'required' || changedOwner)
    this.scope = scope
    if (changedOwner) {
      this.lastObserved = null
      this.largestTimestamp = 0
      this.verifiedAt = Infinity
      this.verifiedObservations = []
      this.interruptedFrom = null
      this.stableSince = null
      this.suspendedAt = null
      this.nativeConfirmed = false
      this.nativeGeometryId = null
      this.publish({ profile: DISPLAY_GUARD_PROFILE })
    }
    if (!owner || scope === 'suspended') {
      this.stableSince = null
      if (owner && !changedOwner && previousScope !== 'suspended')
        this.suspendedAt = this.wallTime()
      this.publish({
        owner,
        required,
        focusRequired,
        unverifiedContinuation,
        phase: owner ? 'suspended' : 'blocked',
        reasons: [],
      })
      return
    }
    this.suspendedAt = null
    const keepVerification = !changedOwner && this.snapshot.phase === 'verified'
    if (entering && !keepVerification) {
      this.stableSince = null
      const needsBoundary = this.interruptedFrom === null
      this.interruptedFrom ??= this.wallTime()
      this.publish({
        owner,
        required,
        focusRequired,
        unverifiedContinuation,
        phase: 'blocked',
        reasons: [this.pendingReason()],
        generation: this.snapshot.generation + 1,
      })
      if (needsBoundary)
        this.event('display_guard_interrupted', this.interruptedFrom, [this.pendingReason()])
    } else {
      this.publish({
        owner,
        required,
        focusRequired,
        unverifiedContinuation,
        ...(changedOwner || previousScope === 'suspended'
          ? { phase: 'blocked' as const, reasons: [] }
          : {}),
      })
    }
    this.check()
  }

  release(owner: string) {
    if (this.snapshot.owner !== owner) return
    this.configure(null, 'suspended')
    this.sink = () => {}
  }

  private invalidate(reasons: DisplayGuardReason[], preceding: number) {
    const interrupted = this.snapshot.phase === 'verified'
    const start = Math.max(0, Math.floor(preceding))
    const extendsInterval = this.interruptedFrom !== null && start < this.interruptedFrom
    if (interrupted || extendsInterval) this.interruptedFrom = start
    this.stableSince = null
    // Keep the verification timestamp for an older event outside our bounded
    // history. The blocked phase itself prevents sample admission.
    this.publish({
      phase: 'blocked',
      reasons,
      generation: this.snapshot.generation + Number(interrupted),
    })
    // An older queued event can arrive after a newer event already blocked the
    // page. Persist the earlier boundary too; the backend unions both starts.
    if (interrupted || extendsInterval) this.event('display_guard_interrupted', start, reasons)
  }

  /** A queued browser event is evidence even if geometry was already restored. */
  interrupt = (reason: DisplayGuardReason, occurredAt?: number) => {
    if (!this.snapshot.enabled || !this.snapshot.owner) return
    if (
      this.scope === 'suspended' &&
      (this.suspendedAt === null ||
        occurredAt === undefined ||
        !Number.isFinite(occurredAt) ||
        occurredAt <= 0 ||
        occurredAt > this.suspendedAt ||
        !Number.isFinite(this.verifiedAt))
    )
      return
    const now = this.wallTime()
    let preceding = Math.min(this.lastObserved ?? now, now)
    if (occurredAt !== undefined && Number.isFinite(occurredAt)) {
      // A sample can be delivered before an older queued resize/blur event.
      // Find a verified observation preceding that event, not its dispatch.
      preceding = Math.min(now, occurredAt, this.verifiedAt)
      for (let index = this.verifiedObservations.length - 1; index >= 0; index--) {
        if (this.verifiedObservations[index] < occurredAt) {
          preceding = Math.min(now, this.verifiedObservations[index])
          break
        }
      }
    }
    if (this.scope === 'suspended') {
      // A queued event from the preceding measured page still corrects its
      // data. Actual SoSci/replay activity remains exempt and never blocks UI.
      const start = Math.max(0, Math.floor(preceding))
      if (this.interruptedFrom === null || start < this.interruptedFrom) {
        this.interruptedFrom = start
        this.event('display_guard_interrupted', start, [reason])
      }
    } else this.invalidate([reason], preceding)
  }

  check = (): boolean => {
    if (!this.snapshot.enabled || this.snapshot.phase === 'suspended') return true
    if (!this.snapshot.owner) return !this.blocking
    const now = this.wallTime()
    const native = this.native()
    if (native.capable && this.snapshot.profile !== NATIVE_VIEWPORT_PROFILE) {
      if (this.snapshot.phase === 'verified')
        this.invalidate(['native_measurement'], this.lastObserved ?? now)
      this.stableSince = null
      this.verifiedAt = Infinity
      this.verifiedObservations = []
      this.interruptedFrom = this.snapshot.required ? now : null
      this.nativeConfirmed = false
      this.nativeGeometryId = null
      this.publish({
        profile: NATIVE_VIEWPORT_PROFILE,
        phase: 'blocked',
        reasons: ['native_measurement'],
      })
      if (this.snapshot.required)
        this.event('display_guard_interrupted', now, ['native_measurement'])
    }
    const usesNative = this.snapshot.profile === NATIVE_VIEWPORT_PROFILE
    const metrics = this.read()
    const reasons: DisplayGuardReason[] = usesNative
      ? [
          ...(!native.proof ? ['native_measurement' as const] : []),
          ...(this.snapshot.focusRequired && (!metrics.visible || !metrics.focused)
            ? ['window_focus' as const]
            : []),
          ...(metrics.extended ? ['multiple_displays' as const] : []),
          ...(metrics.viewport &&
          (metrics.viewport.scale !== 1 || metrics.viewport.x !== 0 || metrics.viewport.y !== 0)
            ? ['viewport_zoom' as const]
            : []),
        ]
      : displayProblems(metrics, this.snapshot.focusRequired)
    if (usesNative && native.proof && native.proof.id !== this.nativeGeometryId) {
      if (this.nativeGeometryId !== null)
        this.invalidate(['native_measurement'], this.lastObserved ?? now)
      this.nativeGeometryId = native.proof.id
    }
    if (now < this.largestTimestamp) reasons.push('clock_changed')
    this.largestTimestamp = Math.max(now, this.largestTimestamp)
    const preceding = Math.min(this.lastObserved ?? now, now)
    this.lastObserved = now
    if (reasons.length) {
      this.invalidate(reasons, preceding)
      return this.taskAllowed()
    }
    if (this.snapshot.phase === 'verified') {
      if (this.verifiedObservations[this.verifiedObservations.length - 1] !== now) {
        this.verifiedObservations.push(now)
        // Long event stalls fall back conservatively to the verification time.
        if (this.verifiedObservations.length > 512) this.verifiedObservations.shift()
      }
      return true
    }
    this.stableSince ??= this.monotonicTime()
    const ready = this.monotonicTime() - this.stableSince >= DISPLAY_STABLE_MS
    // Without the blocking dialog there is nobody to ask: a display that has
    // been correct and unchanged for the stability window verifies itself.
    // A bridge that is about to announce it measures the page would replace
    // this profile a moment later; wait for its answer rather than verify twice.
    const awaitingBridge = !this.blocking && !usesNative && native.pending === true
    if (
      ready &&
      !awaitingBridge &&
      this.snapshot.required &&
      (!this.blocking ||
        (usesNative && this.nativeConfirmed && !this.snapshot.unverifiedContinuation))
    ) {
      this.confirm(now)
      return true
    }
    const settled = ready && !awaitingBridge
    this.publish({
      phase: settled ? 'ready' : 'blocked',
      // On pages that are only monitored a correct display has nothing pending.
      reasons: settled ? (this.blocking ? ['confirmation_required'] : []) : ['checking_display'],
    })
    return this.taskAllowed()
  }

  /** Whether the participant may act; independent of whether gaze is admitted. */
  private taskAllowed() {
    return !this.blocking || !this.snapshot.required || this.snapshot.unverifiedContinuation
  }

  resume = (): boolean => {
    this.check()
    if (!this.snapshot.required || this.snapshot.phase !== 'ready') return false
    this.confirm(this.wallTime())
    return true
  }

  private confirm(now: number) {
    this.nativeConfirmed = this.snapshot.profile === NATIVE_VIEWPORT_PROFILE
    this.verifiedAt = now
    this.verifiedObservations = [now]
    this.event('display_guard_resumed', now, [])
    this.interruptedFrom = null
    this.publish({ phase: 'verified', reasons: [], unverifiedContinuation: false })
  }

  /** Permit piloting without closing the gaze-exclusion interval or claiming verification. */
  continueUnverified = (): boolean => {
    this.check()
    // Only the blocking dialog offers this; an observing guard has nothing to waive.
    if (!this.blocking) return false
    if (!this.snapshot.enabled || !this.snapshot.owner || !this.snapshot.required) return false
    if (this.snapshot.phase === 'verified') return false
    if (!this.snapshot.unverifiedContinuation) {
      this.event('display_guard_continued_unverified', this.wallTime(), this.snapshot.reasons)
      this.publish({ unverifiedContinuation: true })
    }
    return true
  }

  allowsSample = (timestamp: number): boolean => {
    if (!this.snapshot.enabled) return true
    this.check()
    return (
      this.snapshot.required &&
      this.snapshot.phase === 'verified' &&
      Number.isFinite(timestamp) &&
      timestamp >= this.verifiedAt
    )
  }
}

export const displayGuard = new DisplayGuardController(
  DISPLAY_GUARD_ENABLED,
  undefined,
  undefined,
  undefined,
  undefined,
  DISPLAY_GUARD_BLOCKING,
)
export const getDisplayGuardSnapshot = displayGuard.getSnapshot
export const subscribeDisplayGuard = displayGuard.subscribe
export const checkDisplayGuard = displayGuard.check
export const resumeDisplayGuard = displayGuard.resume
export const continueWithUnverifiedDisplay = displayGuard.continueUnverified
export const displayGuardAllowsSample = displayGuard.allowsSample

export function isDisplayGuardBlocking(state: DisplayGuardSnapshot) {
  return (
    state.enabled &&
    state.blocking !== false &&
    state.required &&
    state.phase !== 'verified' &&
    !state.unverifiedContinuation
  )
}

export function displayGuardGeometry() {
  if (!getDisplayGuardSnapshot().enabled) return undefined
  checkDisplayGuard()
  return {
    profile: getDisplayGuardSnapshot().profile ?? DISPLAY_GUARD_PROFILE,
    verified: getDisplayGuardSnapshot().required && getDisplayGuardSnapshot().phase === 'verified',
  }
}
