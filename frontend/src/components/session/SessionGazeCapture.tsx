import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionStep } from '../../api/participant'
import { useGazeCapture } from '../../hooks/useGazeCapture'
import { gazeContext } from '../../lib/gazeContext'
import {
  gazeDeliveryWarning,
  subscribeGazeDelivery,
  reportGazeDelivery,
} from '../../lib/gazeDelivery'
import GazeHealthStatus from './GazeHealthStatus'

export default function SessionGazeCapture({ step }: { step: SessionStep }) {
  const { t } = useTranslation()
  const context = gazeContext(step)
  const health = useGazeCapture(context)
  const warning = useSyncExternalStore(subscribeGazeDelivery, gazeDeliveryWarning)
  return (
    <div className="gaze-health-stack">
      {context && health ? <GazeHealthStatus health={health} retry={health.retry} /> : null}
      {warning ? (
        <div
          className="gaze-health"
          role="status"
          data-aoi="gaze_delivery"
          data-aoi-overlay="true"
          data-aoi-priority="100"
        >
          {t(`gaze_health.previous_${warning}`)}
          <button type="button" className="btn btn-ghost" onClick={() => reportGazeDelivery(null)}>
            {t('gaze_health.dismiss')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
