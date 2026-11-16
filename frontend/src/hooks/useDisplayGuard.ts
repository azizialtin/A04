import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'

import { displayGuard, DISPLAY_GUARD_ENABLED, type DisplayGuardSnapshot } from '../lib/displayGuard'
import { enqueue } from '../lib/outbox'

export function useDisplayGuard(
  owner: string | undefined,
  required: boolean,
  focusRequired: boolean,
): DisplayGuardSnapshot {
  const snapshot = useSyncExternalStore(displayGuard.subscribe, displayGuard.getSnapshot)

  useLayoutEffect(() => {
    displayGuard.configure(owner ?? null, required, focusRequired, (event) =>
      enqueue('event', { ...event }),
    )
  }, [owner, required, focusRequired])

  useLayoutEffect(() => {
    if (!DISPLAY_GUARD_ENABLED || !owner) return
    const check = () => {
      displayGuard.check()
    }
    const eventTime = (event: Event) => {
      const elapsed = performance.now() - event.timeStamp
      // Modern DOM timestamps use the monotonic performance clock. An unknown
      // clock origin must not certify a gap; use the controller's earliest bound.
      return Number.isFinite(elapsed) && event.timeStamp > 0 && elapsed >= 0
        ? Date.now() - elapsed
        : 0
    }
    const geometryChanged = (event: Event) => {
      displayGuard.interrupt('window_size', eventTime(event))
      check()
    }
    const focusChanged = (event: Event) => {
      if (displayGuard.getSnapshot().focusRequired)
        displayGuard.interrupt('window_focus', eventTime(event))
      check()
    }
    const keys = (event: KeyboardEvent) => {
      const state = displayGuard.getSnapshot()
      if (
        state.required &&
        (event.ctrlKey || event.metaKey) &&
        ['+', '=', '-'].includes(event.key)
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    const wheel = (event: WheelEvent) => {
      if (displayGuard.getSnapshot().required && event.ctrlKey) event.preventDefault()
    }
    window.addEventListener('resize', geometryChanged)
    window.addEventListener('focus', check)
    window.addEventListener('blur', focusChanged)
    document.addEventListener('visibilitychange', focusChanged)
    document.addEventListener('fullscreenchange', geometryChanged)
    document.addEventListener('keydown', keys, true)
    document.addEventListener('wheel', wheel, { capture: true, passive: false })
    window.visualViewport?.addEventListener('resize', geometryChanged)
    window.visualViewport?.addEventListener('scroll', check)
    const timer = window.setInterval(check, 125)
    return () => {
      clearInterval(timer)
      window.removeEventListener('resize', geometryChanged)
      window.removeEventListener('focus', check)
      window.removeEventListener('blur', focusChanged)
      document.removeEventListener('visibilitychange', focusChanged)
      document.removeEventListener('fullscreenchange', geometryChanged)
      document.removeEventListener('keydown', keys, true)
      document.removeEventListener('wheel', wheel, true)
      window.visualViewport?.removeEventListener('resize', geometryChanged)
      window.visualViewport?.removeEventListener('scroll', check)
      displayGuard.release(owner)
    }
  }, [owner])

  // Do not admit a new owner/scope using the previous render's verification.
  return useMemo(() => {
    if (!snapshot.enabled) return snapshot
    if (
      snapshot.owner !== (owner ?? null) ||
      snapshot.required !== required ||
      snapshot.focusRequired !== focusRequired
    )
      return {
        ...snapshot,
        phase: required ? 'blocked' : 'suspended',
        reasons: ['checking_display'],
      } as DisplayGuardSnapshot
    return snapshot
  }, [snapshot, owner, required, focusRequired])
}
