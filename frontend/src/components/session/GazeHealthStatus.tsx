import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { getNativeViewportSnapshot, subscribeNativeViewport } from '../../lib/nativeViewport'
import { getDisplayGuardSnapshot, subscribeDisplayGuard } from '../../lib/displayGuard'
import { observeLoopbackPermission } from '../../lib/bridgePermission'
import type { GazeHealth } from '../../lib/gazeConnection'

export default function GazeHealthStatus({
  health,
  retry,
  preflight = false,
  compact = false,
}: {
  health: GazeHealth & { issue?: string | null; mappingVerified?: boolean | null }
  retry: () => void
  preflight?: boolean
  compact?: boolean
}) {
  const { t } = useTranslation()
  const native = useSyncExternalStore(subscribeNativeViewport, getNativeViewportSnapshot)
  const guard = useSyncExternalStore(subscribeDisplayGuard, getDisplayGuardSnapshot)
  const [permission, setPermission] = useState<PermissionState | null>(null)
  const state = health.issue || health.state
  useEffect(() => {
    if (state !== 'bridge_unreachable') return
    return observeLoopbackPermission(setPermission)
  }, [state])
  // Either profile can verify the display; only the bridge-measured one also
  // needs a current measurement behind it.
  const mappingActive = (native.capable || guard.enabled) && !preflight
  const mapped =
    guard.phase === 'verified' &&
    health.mappingVerified === true &&
    (native.capable ? !!native.proof && guard.profile === 'native_viewport_v1' : guard.enabled)
  const healthy = state === 'tracking' && (!mappingActive || mapped)
  const help =
    state === 'bridge_unreachable'
      ? t(permission === 'denied' ? 'gaze_health.permission_denied' : 'gaze_health.connection_help')
      : state === 'tracker_missing'
        ? t('gaze_health.tracker_help')
        : null
  return (
    <div
      className={`gaze-health ${healthy ? 'gaze-health--ready' : ''}`}
      role="status"
      data-aoi="gaze_health"
      data-aoi-overlay="true"
      data-aoi-priority="100"
    >
      <div className="gaze-health__summary">
        <strong>
          {health.mock ? t('gaze_health.mock') + ' ' : ''}
          {t(`gaze_health.${state}`)}
        </strong>
        {mappingActive && (
          <span>{t(mapped ? 'mapping_ready' : 'mapping_waiting', { ns: 'displayGuard' })}</span>
        )}
        <span>{t('gaze_health.counts', { received: health.received, valid: health.valid })}</span>
        {state !== 'tracking' ? (
          <button type="button" className="btn btn-ghost" onClick={retry}>
            {t('gaze_health.retry')}
          </button>
        ) : null}
      </div>
      {help &&
        (compact ? (
          <details>
            <summary>{t('gaze_health.help')}</summary>
            <p>{help}</p>
          </details>
        ) : (
          <p>{help}</p>
        ))}
      {preflight && !healthy ? <p className="small">{t('gaze_health.continue_warning')}</p> : null}
    </div>
  )
}
