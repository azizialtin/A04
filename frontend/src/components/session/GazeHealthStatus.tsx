import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GazeHealth } from '../../lib/gazeConnection'

export default function GazeHealthStatus({
  health,
  retry,
  preflight = false,
}: {
  health: GazeHealth & { issue?: string | null }
  retry: () => void
  preflight?: boolean
}) {
  const { t } = useTranslation()
  const [permission, setPermission] = useState<PermissionState | null>(null)
  const state = health.issue || health.state
  useEffect(() => {
    if (state !== 'bridge_unreachable') return
    let active = true
    let observed: PermissionStatus | null = null
    const update = () => {
      if (active && observed) setPermission(observed.state)
    }
    void (async () => {
      // Chrome 147+ separates loopback permission. A legacy 'prompt' result
      // must not overrule a denied granular permission.
      for (const name of ['loopback-network', 'local-network-access']) {
        try {
          observed = await navigator.permissions.query({ name } as PermissionDescriptor)
          if (!active) return
          update()
          observed.addEventListener('change', update)
          return
        } catch {
          /* Unsupported browsers retain the actionable generic guidance. */
        }
      }
    })()
    return () => {
      active = false
      observed?.removeEventListener('change', update)
    }
  }, [state])
  const healthy = state === 'tracking'
  return (
    <div
      className={`gaze-health ${healthy ? 'gaze-health--ready' : ''}`}
      role="status"
      data-aoi="gaze_health"
      data-aoi-overlay="true"
      data-aoi-priority="100"
    >
      <strong>
        {health.mock ? t('gaze_health.mock') + ' ' : ''}
        {t(`gaze_health.${state}`)}
      </strong>
      <span> {t('gaze_health.counts', { received: health.received, valid: health.valid })}</span>
      {state === 'bridge_unreachable' ? (
        <p>
          {t(
            permission === 'denied'
              ? 'gaze_health.permission_denied'
              : 'gaze_health.connection_help',
          )}
        </p>
      ) : null}
      {state === 'tracker_missing' ? <p>{t('gaze_health.tracker_help')}</p> : null}
      {!healthy ? (
        <button type="button" className="btn btn-ghost" onClick={retry}>
          {t('gaze_health.retry')}
        </button>
      ) : null}
      {preflight && !healthy ? <p className="small">{t('gaze_health.continue_warning')}</p> : null}
    </div>
  )
}
