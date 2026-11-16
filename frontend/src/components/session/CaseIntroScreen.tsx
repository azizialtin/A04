import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { bridgeCanRecord, prepareCapture } from '../../lib/screenCapture'
import StudyText from '../StudyText'
import Modal from '../Modal'
import { useGazePreflight } from '../../hooks/useGazePreflight'
import GazeHealthStatus from './GazeHealthStatus'
import { enqueue } from '../../lib/outbox'

/**
 * Text only: nothing is asked before a case, so the clip is one click away.
 * The wording is the study's where the researcher has written any, and the
 * app's own otherwise.
 *
 * That click is also where the page secures a screen capture when no bridge
 * will make one: the browser only shows its picker from a user gesture, and
 * this is the last one before the clip. With the bridge in place the button
 * behaves as before.
 */
export default function CaseIntroScreen({
  title,
  body,
  videoId,
  onContinue,
  pilot = false,
}: {
  title?: string
  pilot?: boolean
  videoId?: number
  body?: string
  onContinue: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [showHealth, setShowHealth] = useState(false)
  const gaze = useGazePreflight()

  // Warm the probe so the click does not spend its gesture waiting on it.
  useEffect(() => {
    void bridgeCanRecord()
  }, [])

  const proceed = async () => {
    setBusy(true)
    try {
      await prepareCapture()
    } catch {
      /* the run does not stop for a capture */
    } finally {
      // Always: `onContinue` can fail (a blip on the progress PATCH), and a
      // button left disabled would strand the participant on this screen with
      // nothing to click.
      setBusy(false)
    }
    if (gaze.state !== 'tracking')
      enqueue('event', {
        event_type: 'gaze_preflight_continue_without',
        video_id: videoId ?? null,
        client_ts: Date.now(),
        payload: {
          state: gaze.state,
          received: gaze.received,
          valid: gaze.valid,
          mock: !!gaze.mock,
        },
      })
    gaze.close()
    setShowHealth(false)
    onContinue()
  }

  return (
    <div className="panel">
      <h2>{title || t('case_intro.title')}</h2>
      <StudyText text={body || t('case_intro.body')} className="lead" />
      {!pilot && <GazeHealthStatus health={gaze} retry={gaze.retry} preflight />}
      <div className="panel__actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (pilot && gaze.state !== 'tracking') setShowHealth(true)
            else void proceed()
          }}
          disabled={busy}
        >
          {busy
            ? t('case_intro.preparing')
            : pilot || gaze.state === 'tracking'
              ? t('common.continue')
              : t('gaze_health.continue_without')}
        </button>
      </div>
      {pilot && showHealth && (
        <Modal
          open
          title={t('gaze_health.preflight_title')}
          onClose={() => {
            if (!busy) setShowHealth(false)
          }}
          aoiId="gaze_preflight_dialog"
        >
          <GazeHealthStatus health={gaze} retry={gaze.retry} preflight />
          <div className="modal__actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setShowHealth(false)}
            >
              {t('step_back.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void proceed()}
            >
              {busy
                ? t('case_intro.preparing')
                : t(gaze.state === 'tracking' ? 'common.continue' : 'gaze_health.continue_without')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
