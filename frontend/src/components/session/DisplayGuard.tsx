import { useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'

import {
  checkDisplayGuard,
  continueWithUnverifiedDisplay,
  getDisplayGuardSnapshot,
  isDisplayGuardBlocking,
  resumeDisplayGuard,
} from '../../lib/displayGuard'
import Modal from '../Modal'
import './DisplayGuard.css'

type GuardState = ReturnType<typeof getDisplayGuardSnapshot>

export default function DisplayGuard({
  state,
  children,
}: {
  state: GuardState
  children: ReactNode
}) {
  const { t } = useTranslation('displayGuard')
  const content = useRef<HTMLDivElement>(null)
  const [fullscreenFailed, setFullscreenFailed] = useState(false)
  const blocked = isDisplayGuardBlocking(state)

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
            <p>{t(state.profile === 'native_viewport_v1' ? 'native_setup' : 'setup')}</p>
            <p role="status">
              {t(
                state.phase === 'ready'
                  ? state.profile === 'native_viewport_v1'
                    ? 'native_ready'
                    : 'ready'
                  : 'waiting',
              )}
            </p>
            {state.phase !== 'ready' && (
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
