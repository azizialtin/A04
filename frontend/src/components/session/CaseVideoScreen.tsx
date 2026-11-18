import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useVideoNotes } from '../../hooks/participant'
import { checkDisplayGuard } from '../../lib/displayGuard'
import { enqueue } from '../../lib/outbox'
import { latestNote } from '../../lib/notes'
import Modal from '../Modal'
import StudyText from '../StudyText'
import NotesPanel, { type NotesPanelHandle } from './NotesPanel'
import Timer from './Timer'
import VideoPlayer from './VideoPlayer'

interface Props {
  videoId: number
  participantId?: string
  pilot?: boolean
  progressLabel?: string
  infoText: string
  studentTaskText: string
  timeLimitSeconds: number | null
  onComplete: () => Promise<unknown> | void
}

type ContentDialog = 'task' | 'info' | 'student_task'

/**
 * The main screen. Everything the participant does here is logged — entering
 * and leaving, playback, the dialogs, and the notes box — because the
 * analysis reads this stream alongside the gaze samples. See
 * `app/services/log_data.py` for how the event names map onto the study's data
 * dictionary.
 */
export default function CaseVideoScreen({
  videoId,
  participantId,
  infoText,
  studentTaskText,
  timeLimitSeconds,
  onComplete,
  pilot = false,
  progressLabel,
}: Props) {
  const { t } = useTranslation()
  // Empty on a first visit; on a resumed case it brings the notes box back.
  const saved = useVideoNotes(videoId)
  const currentTime = useRef(0)
  const notes = useRef<NotesPanelHandle>(null)
  const [contentDialog, setContentDialog] = useState<ContentDialog | null>(null)
  const dialogCloseReason = useRef('screen_exit')
  const [showExit, setShowExit] = useState(false)
  const [completionPending, setCompletionPending] = useState(false)
  const [completionFailed, setCompletionFailed] = useState(false)
  const completing = useRef(false)

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

  useEffect(() => {
    if (!contentDialog) return
    const openedAt = performance.now()
    let closed = false
    dialogCloseReason.current = 'screen_exit'
    log(`${contentDialog}_opened`, { currentTime: currentTime.current })
    const recordClose = (reason: string) => {
      if (closed) return
      closed = true
      // Exposure is not reading time. Gaze on the text is recorded separately.
      log(`${contentDialog}_closed`, {
        currentTime: currentTime.current,
        durationMs: Math.max(0, Math.round(performance.now() - openedAt)),
        reason,
      })
    }
    const onPageHide = (event: PageTransitionEvent) => {
      // A normal reload does not unmount React; the outbox persists this write.
      // A bfcache page keeps its mounted popup and resumes the same interval.
      if (!event.persisted) recordClose('page_exit')
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      recordClose(dialogCloseReason.current)
    }
  }, [contentDialog, log])

  const openContent = (dialog: ContentDialog) => {
    if (!checkDisplayGuard()) return
    setContentDialog(dialog)
  }
  const closeContent = (reason = 'dismissed') => {
    dialogCloseReason.current = reason
    setContentDialog(null)
  }
  const openExit = () => {
    if (!checkDisplayGuard()) return
    if (completing.current || showExit) return
    setShowExit(true)
    log('case_exit_opened', { currentTime: currentTime.current })
  }
  const closeExit = () => {
    if (completing.current) return
    setShowExit(false)
    log('case_exit_cancelled', { currentTime: currentTime.current })
  }
  const complete = async (reason: 'confirm' | 'timer') => {
    if (reason === 'confirm' && !checkDisplayGuard()) return
    // Timer expiry and a confirmation click may arrive in the same render.
    // Lock synchronously, and keep the lock after success until navigation
    // unmounts this screen. A failed request leaves the case available to retry.
    if (completing.current) return
    completing.current = true
    notes.current?.flush()
    if (reason === 'confirm') log('case_exit_confirmed', { currentTime: currentTime.current })
    setCompletionPending(true)
    setCompletionFailed(false)
    try {
      await onComplete()
    } catch {
      completing.current = false
      setCompletionPending(false)
      setCompletionFailed(true)
      closeContent('completion_failed')
      setShowExit(true)
    }
  }

  return (
    <div className="case-screen">
      <div className="case-screen__video">
        <VideoPlayer videoId={videoId} onTimeUpdate={(s) => (currentTime.current = s)} />
      </div>

      <aside className="case-screen__rail">
        {progressLabel && (
          <p className="rail-phase" data-aoi="phase_label">
            {progressLabel}
          </p>
        )}
        {timeLimitSeconds ? (
          <div className="rail-block" data-aoi="timer">
            <span className="rail-label">{t('case.timer_label')}</span>
            <Timer seconds={timeLimitSeconds} onExpire={() => void complete('timer')} />
          </div>
        ) : null}

        <div className="rail-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => openContent('task')}
            data-aoi="task_button"
            data-aoi-margin="6"
          >
            {t('case.task_button')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => openContent('info')}
            data-aoi="info_button"
            data-aoi-margin="6"
          >
            {t('case.info_title')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => openContent('student_task')}
            data-aoi="student_task_button"
            data-aoi-margin="6"
          >
            {t(pilot ? 'pilot.student_task_button' : 'case.student_task_button')}
          </button>
        </div>

        <div className="rail-block rail-block--notes" data-aoi="notes">
          <span className="rail-label">{t('case.notes_label')}</span>
          <NotesPanel
            ref={notes}
            draftKey={participantId ? `notes.${participantId}.${videoId}` : undefined}
            initialText={latestNote(saved.data ?? [])?.text ?? ''}
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

        <button
          type="button"
          className="btn btn-primary"
          onClick={openExit}
          disabled={completionPending}
          data-aoi="continue"
        >
          {t('case.next')}
        </button>
      </aside>

      <Modal
        open={contentDialog === 'task'}
        title={t('case.task_button')}
        onClose={() => closeContent()}
        aoiId="task_dialog"
        bodyAoiId="task_dialog_text"
      >
        <StudyText text={t('case.task_instructions')} mode="preserve" style={{ margin: 0 }} />
      </Modal>
      <Modal
        open={contentDialog === 'info'}
        title={t('case.info_title')}
        onClose={() => closeContent()}
        aoiId="info_dialog"
        bodyAoiId="info_dialog_text"
      >
        <StudyText text={infoText || t('case.no_content')} mode="preserve" style={{ margin: 0 }} />
      </Modal>
      <Modal
        open={contentDialog === 'student_task'}
        title={t(pilot ? 'pilot.student_task_title' : 'case.student_task_title')}
        onClose={() => closeContent()}
        aoiId="student_task_dialog"
        bodyAoiId="student_task_dialog_text"
      >
        <StudyText
          text={studentTaskText || t('case.no_content')}
          restartCodeBlocks={pilot}
          mode="preserve"
          style={{ margin: 0 }}
        />
      </Modal>
      {/* The player and all capture hooks remain mounted. Opening or cancelling
          this dialog does not change playback or restart a recording clock. */}
      <Modal
        open={showExit}
        title={t('case.exit_title')}
        onClose={closeExit}
        closeDisabled={completionPending}
        aoiId="case_exit_dialog"
      >
        <p>{t('case.exit_body')}</p>
        {completionFailed && (
          <p className="error-text" role="alert">
            {t('case.exit_error')}
          </p>
        )}
        <div className="modal__actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={closeExit}
            disabled={completionPending}
            autoFocus
          >
            {t('case.exit_cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void complete('confirm')}
            disabled={completionPending}
          >
            {completionPending ? t('common.loading') : t('case.exit_confirm')}
          </button>
        </div>
      </Modal>
    </div>
  )
}
