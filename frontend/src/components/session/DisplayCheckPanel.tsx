import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { displayCheckSummary, displayChecklist } from '../../lib/displayCheck'
import {
  getDisplayGuardSnapshot,
  readDisplayMetrics,
  subscribeDisplayGuard,
} from '../../lib/displayGuard'
import {
  getNativeViewportSnapshot,
  nativeViewport,
  subscribeNativeViewport,
} from '../../lib/nativeViewport'
import './DisplayCheckPanel.css'

const REFRESH_MS = 500
const MARK = { ok: '✓', warn: '!', fail: '✕', info: '…' } as const

/** F11 and the Fullscreen API alike; sizes alone mislead once the page is zoomed. */
function browserFullscreen(): boolean {
  return (
    !!document.fullscreenElement ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: fullscreen)').matches)
  )
}

function useDisplayChecklist() {
  const guard = useSyncExternalStore(subscribeDisplayGuard, getDisplayGuardSnapshot)
  const native = useSyncExternalStore(subscribeNativeViewport, getNativeViewportSnapshot)
  const [metrics, setMetrics] = useState(readDisplayMetrics)
  useEffect(() => {
    const read = () => setMetrics(readDisplayMetrics())
    const timer = window.setInterval(read, REFRESH_MS)
    window.addEventListener('resize', read)
    window.addEventListener('focus', read)
    window.addEventListener('blur', read)
    document.addEventListener('fullscreenchange', read)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', read)
      window.removeEventListener('focus', read)
      window.removeEventListener('blur', read)
      document.removeEventListener('fullscreenchange', read)
    }
  }, [])
  const rows = displayChecklist(metrics, guard, native, browserFullscreen())
  return { guard, native, rows, summary: displayCheckSummary(rows) }
}

/** Setup details stay on the welcome page and open only at the user's request. */
export function DisplayCheckSection() {
  const { t } = useTranslation('displayGuard')
  const { guard, native, rows, summary } = useDisplayChecklist()
  const [fullscreenFailed, setFullscreenFailed] = useState(false)
  const differences = rows.filter(
    (row) => row.status !== 'ok' && row.current.id !== 'mapping_paused',
  )
  const fullscreen = async () => {
    setFullscreenFailed(false)
    try {
      if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen unavailable')
      await document.documentElement.requestFullscreen()
    } catch {
      setFullscreenFailed(true)
    }
  }
  const text = (value: { id: string; values?: Record<string, number> }) =>
    t(`check.value.${value.id}`, value.values)

  return (
    <details className="display-check__section" data-display-check={summary}>
      <summary className={`display-check__summary--${summary}`}>
        {t(`check.disclosure.${summary}`)}
      </summary>
      <div className="display-check">
        <p>{t(`check.summary.${summary}`)}</p>
        {differences.length > 0 && (
          <ul className="display-check__differences" aria-label={t('check.differences')}>
            {differences.map((row) => (
              <li key={row.key} data-check={row.key} data-status={row.status}>
                <h3>{t(`check.row.${row.key}`)}</h3>
                <p className={`display-check__status display-check__status--${row.status}`}>
                  <span aria-hidden="true">{MARK[row.status]}</span>{' '}
                  {t(`check.status.${row.status}`)}
                </p>
                <p className="display-check__current">
                  <strong>{t('check.column.current')}:</strong> {text(row.current)}
                </p>
                <p className="display-check__expected">
                  <strong>{t('check.column.expected')}:</strong> {text(row.expected)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {differences.length > 0 && (
          <p className="muted">{t(native.capable ? 'check.note_native' : 'check.note_legacy')}</p>
        )}
        <p className="muted">{t('check.note_unverified')}</p>
        {fullscreenFailed && <p role="alert">{t('fullscreen_failed')}</p>}
        <div className="display-check__actions">
          <button type="button" className="btn btn-secondary" onClick={() => void fullscreen()}>
            {t('fullscreen')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={
              !guard.owner ||
              native.connection === 'permission_pending' ||
              (native.connection === 'connected' && native.capable && !!native.proof)
            }
            onClick={() => nativeViewport.retry()}
          >
            {t('retry_bridge')}
          </button>
        </div>
      </div>
    </details>
  )
}
