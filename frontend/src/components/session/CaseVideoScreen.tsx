import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useVideoNotes } from '../../hooks/participant'
import { enqueue } from '../../lib/outbox'
import Modal from '../Modal'
import StudyText from '../StudyText'
import NotesPanel from './NotesPanel'
import Timer from './Timer'
import VideoPlayer from './VideoPlayer'

interface Props {
  videoId: number
  taskDescription: string
  infoText: string
  studentTaskText: string
  timeLimitSeconds: number | null
  onComplete: () => void
}

/**
 * The main screen. Everything the participant does here is logged — entering
 * and leaving, playback, the two dialogs, and the notes box — because the
 * analysis reads this stream alongside the gaze samples. See
 * `app/services/log_data.py` for how the event names map onto the study's data
 * dictionary.
 */
export default function CaseVideoScreen({
  videoId,
  taskDescription,
  infoText,
  studentTaskText,
  timeLimitSeconds,
  onComplete,
}: Props) {
  const { t } = useTranslation()
  // Empty on a first visit; on a resumed case it brings the notes box back.
  const saved = useVideoNotes(videoId)
  const currentTime = useRef(0)
  const [showInfo, setShowInfo] = useState(false)
  const [showTask, setShowTask] = useState(false)

  const log = useCallback(
    (eventType: string, payload: Record<string, unknown> = {}) =>
      enqueue('event', {
        event_type: eventType,
        video_id: videoId,
        // Stamped here rather than server-side: these line up against gaze
        // samples and the screen recording, which run on this machine's clock.
        client_ts: Date.now(),
        payload,
      }),
    [videoId],
  )

  useEffect(() => {
    log('case_screen_entered')
    return () => log('case_screen_exited')
  }, [log])

  const openInfo = () => {
    setShowInfo(true)
    log('info_opened')
  }
  const closeInfo = () => {
    setShowInfo(false)
    log('info_closed')
  }
  const openTask = () => {
    setShowTask(true)
    log('student_task_opened')
  }
  const closeTask = () => {
    setShowTask(false)
    log('student_task_closed')
  }

  return (
    <div className="case-screen">
      <div className="case-screen__video">
        <VideoPlayer videoId={videoId} onTimeUpdate={(s) => (currentTime.current = s)} />
      </div>

      <aside className="case-screen__rail">
        {timeLimitSeconds ? (
          <div className="rail-block" data-aoi="timer">
            <span className="rail-label">{t('case.timer_label')}</span>
            <Timer seconds={timeLimitSeconds} onExpire={onComplete} />
          </div>
        ) : null}

        <div className="rail-block" data-aoi="task">
          <span className="rail-label">{t('case.task_label')}</span>
          <StudyText text={taskDescription} className="rail-task" />
        </div>

        <div className="rail-actions">
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={openInfo}
            data-aoi="info_button"
          >
            i
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={openTask}
            data-aoi="student_task_button"
          >
            {t('case.student_task_button')}
          </button>
        </div>

        <div className="rail-block rail-block--notes" data-aoi="notes">
          <span className="rail-label">{t('case.notes_label')}</span>
          <NotesPanel
            initialText={saved.data?.length ? saved.data[saved.data.length - 1].text : ''}
            getVideoTime={() => currentTime.current}
            onFocus={() => log('notes_focused')}
            onTypingBurst={(durationMs, length) => log('notes_typed', { durationMs, length })}
            onSnapshot={(videoTimeSeconds, text) =>
              // Queued rather than fired and forgotten: a note the participant
              // watched themselves type must not disappear on a network blip.
              enqueue('note', {
                video_id: videoId,
                video_time_seconds: videoTimeSeconds,
                // Stamped here, not on the server: the think-aloud replays a
                // screen recording, which runs on this machine's wall clock.
                client_ts: Date.now(),
                text,
              })
            }
          />
        </div>

        <button type="button" className="btn btn-primary" onClick={onComplete} data-aoi="continue">
          {t('case.next')}
        </button>
      </aside>

      <Modal open={showInfo} title={t('case.info_title')} onClose={closeInfo} aoiId="info_dialog">
        <StudyText text={infoText || t('case.no_content')} mode="preserve" style={{ margin: 0 }} />
      </Modal>
      <Modal
        open={showTask}
        title={t('case.student_task_title')}
        onClose={closeTask}
        aoiId="student_task_dialog"
      >
        <StudyText
          text={studentTaskText || t('case.no_content')}
          mode="preserve"
          style={{ margin: 0 }}
        />
      </Modal>
    </div>
  )
}
