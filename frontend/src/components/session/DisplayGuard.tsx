import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

import { APP_VERSION, appBundle } from '../../lib/appVersion'
import { observeLoopbackPermission } from '../../lib/bridgePermission'
import {
  checkDisplayGuard,
  continueWithUnverifiedDisplay,
  getDisplayGuardSnapshot,
  isDisplayGuardBlocking,
  resumeDisplayGuard,
} from '../../lib/displayGuard'
import {
  getNativeViewportSnapshot,
  nativeViewport,
  subscribeNativeViewport,
} from '../../lib/nativeViewport'
import Modal from '../Modal'
import './DisplayGuard.css'

type GuardState = ReturnType<typeof getDisplayGuardSnapshot>

const measurementHelp: Record<string, string> = {
  window_focus: 'focus',
  not_foreground: 'focus',
  multiple_displays: 'displays',
  viewport_size_mismatch: 'geometry',
  viewport_unavailable: 'geometry',
  viewport_ambiguous: 'geometry',
  invalid_measurement: 'geometry',
  native_query_failed: 'geometry',
  invalid_dimensions: 'geometry',
  viewport_zoom: 'zoom',
  unsupported_platform: 'platform',
  dpi_awareness_unavailable: 'platform',
  display_unavailable: 'displays',
  tab_owned: 'tabs',
  probe_limit: 'tabs',
  invalid_probe: 'upgrade',
  stale_measurement: 'stale',
}

export default function DisplayGuard({
  state,
  children,
}: {
  state: GuardState
  children: ReactNode
}) {
  const { t } = useTranslation('displayGuard')
  const native = useSyncExternalStore(subscribeNativeViewport, getNativeViewportSnapshot)
  const content = useRef<HTMLDivElement>(null)
  const [fullscreenFailed, setFullscreenFailed] = useState(false)
  const [permission, setPermission] = useState<PermissionState | null>(null)
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const blocked = isDisplayGuardBlocking(state)
  const connection = native.owner === state.owner ? native.connection : 'idle'
  const errorCode =
    native.owner === state.owner && native.errorCode && /^[a-z_]{1,64}$/.test(native.errorCode)
      ? native.errorCode
      : null
  const help = errorCode ? measurementHelp[errorCode] : undefined

  useEffect(() => {
    if (!blocked) return
    return observeLoopbackPermission(setPermission)
  }, [blocked])

  useLayoutEffect(() => {
    if (content.current) content.current.inert = blocked
  }, [blocked, state.enabled])

  const protect = (event: SyntheticEvent) => {
    if (checkDisplayGuard()) return
    event.preventDefault()
    event.stopPropagation()
  }
  const fullscreen = async () => {
    setFullscreenFailed(false)
    try {
      if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen unavailable')
      await document.documentElement.requestFullscreen()
    } catch {
      setFullscreenFailed(true)
    }
  }
  // Deliberately omit participant identity, tab nonce, native proof ID, page
  // title and URL. This text can safely be sent to technical support.
  const diagnostics = JSON.stringify(
    {
      app_version: APP_VERSION,
      app_bundle: appBundle(),
      bridge_connection: connection,
      native_capability: native.owner === state.owner && native.capable,
      bridge_error: errorCode,
      loopback_permission: permission ?? 'unknown',
      guard_profile: state.profile ?? 'lab_1080p',
      guard_phase: state.phase,
      guard_reasons: state.reasons,
      viewport_css: { w: window.innerWidth, h: window.innerHeight },
      device_pixel_ratio: window.devicePixelRatio,
    },
    null,
    2,
  )
  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }

  if (!state.enabled) return children
  return (
    <>
      <div
        ref={content}
        className="display-guard__content"
        aria-hidden={blocked || undefined}
        onClickCapture={protect}
        onSubmitCapture={protect}
        onChangeCapture={protect}
        onPasteCapture={protect}
        onDropCapture={protect}
        onBeforeInputCapture={protect}
        onKeyDownCapture={(event) => {
          // Browser zoom recovery remains available even when task input is blocked.
          if ((event.ctrlKey || event.metaKey) && event.key === '0') return
          protect(event)
        }}
      >
        {children}
      </div>
      {blocked && (
        <div className="display-guard" data-display-guard={state.phase}>
          <Modal
            open
            title={t('title')}
            onClose={() => {}}
            closeDisabled
            focusPriority={100}
            aoiId="display_guard_dialog"
          >
            <p>{t('body')}</p>
            {connection !== 'idle' && (
              <div aria-label={t('bridge_status')}>
                <p>
                  <strong>{t(`connection.${connection}`)}</strong>
                </p>
                {(connection === 'connecting' ||
                  connection === 'unreachable' ||
                  connection === 'permission_pending') && (
                  <p>{t(permission === 'denied' ? 'permission_denied' : 'connection_help')}</p>
                )}
                {connection === 'upgrade_required' && <p>{t('recovery.upgrade')}</p>}
                {connection === 'connected' && help && state.phase !== 'ready' && (
                  <p>{t(`recovery.${help}`)}</p>
                )}
              </div>
            )}
            <div className="modal__actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={connection === 'permission_pending'}
                onClick={() => nativeViewport.retry()}
              >
                {t('retry_bridge')}
              </button>
              <a
                className="btn btn-secondary"
                href="/downloads/A04Bridge-native-20261117.zip"
                download
              >
                {t('download_bridge')}
              </a>
            </div>
            <p>
              {t(
                connection === 'connected'
                  ? 'native_setup'
                  : connection === 'upgrade_required' || connection === 'idle'
                    ? 'setup'
                    : 'connection_setup',
              )}
            </p>
            <p role="status">
              {t(
                state.phase === 'ready'
                  ? state.profile === 'native_viewport_v1'
                    ? 'native_ready'
                    : 'ready'
                  : 'waiting',
              )}
            </p>
            {state.phase !== 'ready' &&
              (connection === 'connected' ||
                connection === 'upgrade_required' ||
                connection === 'idle') && (
                <ul>
                  {state.reasons.map((reason) => (
                    <li key={reason}>{t(`reasons.${reason}`)}</li>
                  ))}
                </ul>
              )}
            <p>{t('continue_unverified_notice')}</p>
            <p className="muted">{t('timers')}</p>
            {fullscreenFailed && <p role="alert">{t('fullscreen_failed')}</p>}
            <div className="modal__actions">
              <button type="button" className="btn btn-secondary" onClick={() => void fullscreen()}>
                {t('fullscreen')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={state.phase !== 'ready'}
                onClick={() => resumeDisplayGuard()}
              >
                {t('resume')}
              </button>
            </div>
            <details>
              <summary tabIndex={0}>{t('diagnostics', { version: APP_VERSION })}</summary>
              <pre aria-label={t('diagnostic_text')}>{diagnostics}</pre>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void copyDiagnostics()}
              >
                {t('copy_diagnostics')}
              </button>
              {copied && <p role="status">{t(`copied.${copied}`)}</p>}
            </details>
            <div className="modal__actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => continueWithUnverifiedDisplay()}
              >
                {t('continue_unverified')}
              </button>
            </div>
          </Modal>
        </div>
      )}
    </>
  )
}
