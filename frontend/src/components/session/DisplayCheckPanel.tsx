import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
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
import Modal from '../Modal'
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

/**
 * The display settings as they are now, next to what the study expects. It
 * informs and never holds anyone: the study lead reads it before a session and
 * decides. Gaze recorded on a display that is not verified is kept, but is not
 * assigned to areas.
 */
export function DisplayCheckTable() {
  const { t } = useTranslation('displayGuard')
  const { guard, native, rows, summary } = useDisplayChecklist()
  const [fullscreenFailed, setFullscreenFailed] = useState(false)
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
    <div className="display-check" data-display-check={summary}>
      <p className={`display-check__summary display-check__summary--${summary}`} role="status">
        {t(`check.summary.${summary}`)}
      </p>
      <table className="table display-check__table">
        <thead>
          <tr>
            <th scope="col">{t('check.column.setting')}</th>
            <th scope="col">{t('check.column.current')}</th>
            <th scope="col">{t('check.column.expected')}</th>
            <th scope="col">{t('check.column.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-check={row.key} data-status={row.status}>
              <th scope="row">{t(`check.row.${row.key}`)}</th>
              <td>{text(row.current)}</td>
              <td>{text(row.expected)}</td>
              <td className={`display-check__status display-check__status--${row.status}`}>
                <span aria-hidden="true">{MARK[row.status]}</span> {t(`check.status.${row.status}`)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">{t(native.capable ? 'check.note_native' : 'check.note_legacy')}</p>
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
  )
}

/** On the first screen: open when something needs attention, folded away when not. */
export function DisplayCheckSection() {
  const { t } = useTranslation('displayGuard')
  const { summary } = useDisplayChecklist()
  // Follows the result until the study lead opens or closes it themselves.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? summary !== 'ok'
  return (
    <details
      className="panel display-check__section"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        if (next !== open) setChosen(next)
      }}
    >
      <summary>
        {t('check.title')} · {t(`check.short.${summary}`)}
      </summary>
      <DisplayCheckTable />
    </details>
  )
}

/**
 * On a measured page: offered only while the display keeps gaze from being
 * assigned, and only opened on request. It never appears by itself.
 */
export function DisplayCheckButton() {
  const { t } = useTranslation('displayGuard')
  const guard = useSyncExternalStore(subscribeDisplayGuard, getDisplayGuardSnapshot)
  const [open, setOpen] = useState(false)
  const settling = guard.reasons.every(
    (reason) => reason === 'checking_display' || reason === 'confirmation_required',
  )
  const needed = guard.enabled && guard.required && guard.phase !== 'verified' && !settling
  const focusOnly = guard.reasons.length === 1 && guard.reasons[0] === 'window_focus'
  if (!needed && !open) return null
  return (
    <>
      <div
        className="gaze-health"
        role="status"
        data-aoi="display_check_notice"
        data-aoi-overlay="true"
        data-aoi-priority="100"
      >
        {t(focusOnly ? 'check.notice_focus' : 'check.notice')}
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          {t('check.open')}
        </button>
      </div>
      {/* The status stack lets clicks through to the page; a dialog must not. */}
      {createPortal(
        <Modal
          open={open}
          title={t('check.title')}
          onClose={() => setOpen(false)}
          aoiId="display_check_dialog"
        >
          <DisplayCheckTable />
        </Modal>,
        document.body,
      )}
    </>
  )
}
