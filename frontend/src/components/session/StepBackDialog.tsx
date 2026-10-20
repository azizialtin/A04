import { useTranslation } from 'react-i18next'

import type { SessionStep } from '../../api/participant'
import { stepLabel } from '../../lib/stepBack'
import Modal from '../Modal'

/**
 * The confirmation behind the supervisor's key chord. It names the screen the
 * run is on and the one it would go back to, so a wrong press costs nothing.
 */
export default function StepBackDialog({
  from,
  to,
  atStart,
  busy,
  onCancel,
  onConfirm,
}: {
  from: SessionStep | undefined
  to: SessionStep | undefined
  atStart: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <Modal open title={t('step_back.title')} onClose={onCancel} aoiId="supervisor_dialog">
      {atStart ? (
        <p>{t('step_back.at_start')}</p>
      ) : (
        <>
          <p>{t('step_back.body', { from: stepLabel(from, t), to: stepLabel(to, t) })}</p>
          <p className="muted small">{t('step_back.note')}</p>
        </>
      )}
      <div className="modal__actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('step_back.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={atStart || busy}
          onClick={onConfirm}
        >
          {t('step_back.confirm')}
        </button>
      </div>
    </Modal>
  )
}
