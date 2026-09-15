import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import apiClient from '../../api/client'
import type { NoteSnapshot, ReplayData } from '../../api/participant'
import { useVideoNotes, useVideoReplay } from '../../hooks/participant'
import { frameToElement } from '../../lib/gazeGeometry'
import { settleDuration } from '../../lib/media'
import { gazeAt, notesOnClip, notesOnRecording, textAt } from '../../lib/replay'
import { uploadSettled } from '../../lib/screenCapture'

/** Which case this recording is of, and where it sits in a block of them. */
export interface ThinkAloudPosition {
  phaseType: string
  caseNumber: number
  caseTotal: number
  batchPosition: number
  batchSize: number
}

interface Props {
  videoId: number
  position?: ThinkAloudPosition
  onComplete: () => void
}

// How long to wait for this case's own capture before playing what is already
// stored. Long enough for a case-sized upload on a slow connection, short
// enough that nobody is left staring at a line of text.
const UPLOAD_WAIT_MS = 60_000

/**
 * Cued retrospective think-aloud: replays the case with the participant's gaze
 * dot and their notes in sync, for them to narrate to the study manager.
 *
 * What plays is normally the screen recording — the clip as they saw it, with
 * their cursor, the notes box, the timer, every dialog they opened. When the
 * capture failed it falls back to the clip alone, which still carries the gaze
 * but not what the participant was doing with the rest of the screen.
 *
 * A study may batch the training phase, so this screen can be the second of
 * three recordings of cases worked through a while ago. It therefore says
 * which case is playing rather than leaving the participant to recognise it.
 */
export default function ThinkAloudScreen({ videoId, position, onComplete }: Props) {
  const { t } = useTranslation()
  // A capture the page recorded itself may still be on its way up; asking for
  // the replay before it lands would get the clip instead.
  const [uploaded, setUploaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    // Reset when the case changes: a block of think-alouds renders this
    // component several times in a row, and the second must wait for its own
    // capture rather than inherit the first one's answer.
    setUploaded(false)
    const go = () => {
      if (!cancelled) setUploaded(true)
    }
    // Capped, and never left to a rejection: an upload that stalls must cost
    // the gaze overlay, not the participant's way forward.
    const timer = window.setTimeout(go, UPLOAD_WAIT_MS)
    void uploadSettled(videoId).then(go, go)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [videoId])
  const replay = useVideoReplay(videoId, uploaded)
  const notes = useVideoNotes(videoId)

  if (!uploaded) {
    return <div className="fullpage">{t('think_aloud.saving')}</div>
  }
  if (replay.isLoading || notes.isLoading) {
    return <div className="fullpage">{t('common.loading')}</div>
  }
  if (replay.isError || !replay.data) {
    return <div className="fullpage is-danger">{t('session.error')}</div>
  }

  const batched = (position?.batchSize ?? 1) > 1

  return (
    <div className="think-aloud">
      <header className="think-aloud__head">
        {position ? (
          <p className="muted small">
            {t('session.case_position', {
              phase: t(`session.phase.${position.phaseType}`, {
                defaultValue: position.phaseType,
              }),
              current: position.caseNumber,
              total: position.caseTotal,
            })}
          </p>
        ) : null}
        <h2>
          {batched
            ? t('think_aloud.title_numbered', {
                current: position?.batchPosition,
                total: position?.batchSize,
              })
            : t('think_aloud.title')}
        </h2>
        <p className="muted">{t('think_aloud.hint')}</p>
        {/* Said once, at the top of a block: several recordings in a row is
            not what the earlier cases led them to expect. */}
        {batched && position?.batchPosition === 1 ? (
          <p className="muted">{t('think_aloud.batch_hint', { total: position.batchSize })}</p>
        ) : null}
      </header>

      <ReplayPlayer replay={replay.data} notes={notes.data ?? []} />

      <footer className="think-aloud__foot">
        <span className="muted">
          {t('think_aloud.stats', { points: replay.data.plotted_points })}
          {replay.data.source === 'clip' ? ` · ${t('think_aloud.clip_only')}` : ''}
          {replay.data.recorder === 'browser' ? ` · ${t('think_aloud.browser_capture')}` : ''}
        </span>
        <button type="button" className="btn btn-primary btn-lg" onClick={onComplete}>
          {t('think_aloud.next')}
        </button>
      </footer>
    </div>
  )
}

function ReplayPlayer({ replay, notes }: { replay: ReplayData; notes: NoteSnapshot[] }) {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)
  const captionRef = useRef<HTMLDivElement>(null)
  const [showGaze, setShowGaze] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Read inside the animation loop, which must not be torn down and rebuilt
  // every time the checkbox moves.
  const showGazeRef = useRef(showGaze)
  showGazeRef.current = showGaze

  const url = replay.video_url.startsWith('/')
    ? `${apiClient.defaults.baseURL}${replay.video_url}`
    : replay.video_url

  // On a screen recording the playhead is wall time, so the notes go on it by
  // their own timestamp; on the clip it is clip time, so they go on by playhead.
  const timeline = useMemo(
    () =>
      replay.source === 'screen' && replay.epoch_ms !== null
        ? notesOnRecording(notes, replay.epoch_ms)
        : notesOnClip(notes),
    [notes, replay.source, replay.epoch_ms],
  )

  // The gaze dot has to be a child of the element that goes fullscreen, or it
  // vanishes the instant the video does. So fullscreen the stage — video and
  // dot together — not the <video>, and hide its native fullscreen button.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    const stage = stageRef.current
    if (!stage) return
    if (document.fullscreenElement === stage) {
      document.exitFullscreen().catch(() => {})
    } else {
      stage.requestFullscreen().catch(() => {})
    }
  }

  // Match the stage to the clip's real dimensions so it wraps the picture with
  // no stray letterbox at any window size; fullscreen overrides it to fill.
  const fitStage = () => {
    const video = videoRef.current
    const stage = stageRef.current
    if (video && stage && video.videoWidth && video.videoHeight) {
      stage.style.setProperty('--replay-aspect', `${video.videoWidth} / ${video.videoHeight}`)
    }
    // A browser-made capture arrives without a duration; give it one.
    if (video) settleDuration(video)
  }

  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      const dot = dotRef.current
      const stage = stageRef.current
      if (!video || !dot || !stage) return

      const g = showGazeRef.current ? gazeAt(replay.points, video.currentTime * 1000) : null
      if (!g) {
        dot.style.opacity = '0'
      } else {
        // Measure the video's actually-rendered box and place the point inside
        // it, relative to the stage the dot lives in. Real rects make it exact
        // at any size, DPI or fullscreen — nothing assumes the video and the
        // stage share an origin. Points are 0..1 of the picture (the whole
        // display on a screen recording, the clip's frame on a clip one), which
        // object-fit letterboxes inside the element.
        const vb = video.getBoundingClientRect()
        const sb = stage.getBoundingClientRect()
        const { left, top } = frameToElement(
          g,
          { width: vb.width, height: vb.height },
          { width: video.videoWidth, height: video.videoHeight },
        )
        dot.style.opacity = '1'
        dot.style.left = `${vb.left - sb.left + left}px`
        dot.style.top = `${vb.top - sb.top + top}px`
      }

      if (captionRef.current) {
        captionRef.current.textContent = textAt(timeline, video.currentTime * 1000)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [replay.points, timeline])

  return (
    <div className="replay">
      <div ref={stageRef} className="replay__stage">
        <video
          ref={videoRef}
          src={url}
          controls
          controlsList="nofullscreen noremoteplayback"
          disablePictureInPicture
          onLoadedMetadata={fitStage}
          className="replay__video"
        />
        <div ref={dotRef} className="gaze-dot" aria-hidden="true" />
        {/* The participant's own notes, over the picture: a cue to narrate
            from that costs the video none of its width. */}
        <div ref={captionRef} className="replay__caption" aria-hidden="true" />
        <button
          type="button"
          className="replay__fs"
          onClick={toggleFullscreen}
          title={t(isFullscreen ? 'think_aloud.exit_fullscreen' : 'think_aloud.fullscreen')}
          aria-label={t(isFullscreen ? 'think_aloud.exit_fullscreen' : 'think_aloud.fullscreen')}
        >
          {isFullscreen ? '×' : '⛶'}
        </button>
      </div>
      <label className="replay__toggle">
        <input type="checkbox" checked={showGaze} onChange={(e) => setShowGaze(e.target.checked)} />
        {t('think_aloud.show_gaze')}
      </label>
    </div>
  )
}
