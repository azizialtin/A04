import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'

import {
  displayGuard,
  DISPLAY_GUARD_ENABLED,
  type DisplayGuardScope,
  type DisplayGuardSnapshot,
} from '../lib/displayGuard'
import { nativeViewport } from '../lib/nativeViewport'
import { enqueue } from '../lib/outbox'

export function useDisplayGuard(
  owner: string | undefined,
  scope: DisplayGuardScope,
): DisplayGuardSnapshot {
  const required = scope === 'required'
  const focusRequired = required
  const snapshot = useSyncExternalStore(displayGuard.subscribe, displayGuard.getSnapshot)

  useLayoutEffect(() => {
    displayGuard.configure(owner ?? null, scope, (event) => enqueue('event', { ...event }))
    if (DISPLAY_GUARD_ENABLED) nativeViewport.configure(owner ?? null, scope !== 'suspended')
  }, [owner, scope])

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
    let inner = { w: window.innerWidth, h: window.innerHeight }
    const geometryChanged = (event: Event) => {
      inner = { w: window.innerWidth, h: window.innerHeight }
      displayGuard.interrupt('window_size', eventTime(event))
      nativeViewport.invalidate('checking_display')
      check()
    }
    // The visual viewport also resizes when a scrollbar appears or goes: a page
    // grew past the screen, or shrank back. The window, its position and the
    // zoom are what they were, so the display is still the verified one. Only a
    // changed window or a pinch zoom is evidence against it.
    const visualViewportChanged = (event: Event) => {
      const viewport = window.visualViewport
      const unchanged =
        window.innerWidth === inner.w &&
        window.innerHeight === inner.h &&
        (!viewport ||
          (viewport.scale === 1 && viewport.offsetLeft === 0 && viewport.offsetTop === 0))
      if (unchanged) check()
      else geometryChanged(event)
    }
    const focusChanged = (event: Event) => {
      // A queued blur can originate on the preceding measured page. Quiet
      // pages keep that boundary without preventing their own interaction.
      displayGuard.interrupt('window_focus', eventTime(event))
      nativeViewport.invalidate('window_focus')
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
    window.visualViewport?.addEventListener('resize', visualViewportChanged)
    window.visualViewport?.addEventListener('scroll', check)
    const stopNative = nativeViewport.subscribe(check)
    const timer = window.setInterval(check, 125)
    return () => {
      clearInterval(timer)
      stopNative()
      nativeViewport.release(owner)
      window.removeEventListener('resize', geometryChanged)
      window.removeEventListener('focus', check)
      window.removeEventListener('blur', focusChanged)
      document.removeEventListener('visibilitychange', focusChanged)
      document.removeEventListener('fullscreenchange', geometryChanged)
      document.removeEventListener('keydown', keys, true)
      document.removeEventListener('wheel', wheel, true)
      window.visualViewport?.removeEventListener('resize', visualViewportChanged)
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
        owner: owner ?? null,
        unverifiedContinuation:
          snapshot.owner === (owner ?? null) && snapshot.unverifiedContinuation,
        required,
        focusRequired,
        phase: required ? 'blocked' : 'suspended',
        reasons: ['checking_display'],
      } as DisplayGuardSnapshot
    return snapshot
  }, [snapshot, owner, required, focusRequired])
}
