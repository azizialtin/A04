import { useEffect } from 'react'

import { APP_VERSION, appBundle } from '../lib/appVersion'
import { observeLoopbackPermission } from '../lib/bridgePermission'
import { DISPLAY_GUARD_ENABLED } from '../lib/displayGuard'
import { getNativeViewportSnapshot, subscribeNativeViewport } from '../lib/nativeViewport'
import { enqueue } from '../lib/outbox'

/** Record connection failures even before the blocked questionnaire can mount. */
export function useClientDiagnostics(owner: string | undefined) {
  useEffect(() => {
    if (!DISPLAY_GUARD_ENABLED || !owner) return
    let permission: PermissionState | null = null
    // Geometry heartbeats and repeated retry loops must not flood study events.
    const reported = new Set<string>()
    const report = () => {
      const state = getNativeViewportSnapshot()
      if (state.owner !== owner) return
      const payload = {
        app_version: APP_VERSION,
        bundle: appBundle(),
        bridge_connection: state.connection,
        native_capability: state.capable,
        bridge_error:
          state.errorCode && /^[a-z_]{1,64}$/.test(state.errorCode) ? state.errorCode : null,
        loopback_permission: permission ?? 'unknown',
      }
      const key = JSON.stringify(payload)
      if (reported.has(key) || reported.size >= 40) return
      reported.add(key)
      enqueue('event', {
        event_type: 'display_connection_status',
        client_ts: Date.now(),
        payload,
      })
    }
    const stopNative = subscribeNativeViewport(report)
    const stopPermission = observeLoopbackPermission((value) => {
      permission = value
      report()
    })
    report()
    return () => {
      stopNative()
      stopPermission()
    }
  }, [owner])
}
