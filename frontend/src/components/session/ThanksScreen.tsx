import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { useAuth } from '../../contexts/AuthContext'

interface Props {
  /** Writes from this run that have not reached the server yet. */
  pendingWrites?: number
}

/**
 * The closing screen, and on a lab machine the hand-over between two sittings:
 * the button ends the session and goes back to the id prompt, so the study
 * manager does not have to find the way there themselves.
 *
 * It waits while anything is still queued. Logging out parks those writes until
 * that participant signs in again — which, once they have left the room, they
 * never will. Waiting cannot strand the lab: a queue that will not drain means
 * the backend is unreachable, and the next participant could not log in either.
 */
export default function ThanksScreen({ pendingWrites = 0 }: Props) {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const navigate = useNavigate()

  const startNext = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="fullpage">
      <div className="panel panel--center">
        <h1>{t('thanks.title')}</h1>
        <p className="lead">{t('thanks.body')}</p>
        <div className="panel__actions">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={startNext}
            disabled={pendingWrites > 0}
          >
            {t('thanks.next_participant')}
          </button>
        </div>
        {pendingWrites > 0 && (
          <p className="muted">
            {t('thanks.next_participant_waiting', { pending: pendingWrites })}
          </p>
        )}
      </div>
    </div>
  )
}
