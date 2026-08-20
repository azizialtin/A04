import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import apiClient from '../../api/client'
import type { NoteSnapshot, ReplayData } from '../../api/participant'
import { useVideoNotes, useVideoReplay } from '../../hooks/participant'
import { frameToElement } from '../../lib/gazeGeometry'
import { gazeAt, notesOnClip, notesOnRecording, textAt } from '../../lib/replay'

interface Props {
  videoId: number
  onComplete: () => void
}

/**
 * Cued retrospective think-aloud: replays the case with the participant's gaze
 * dot and their notes in sync, for them to narrate to the study manager.
 *
 * What plays is normally the screen recording — the clip as they saw it, with
 * their cursor, the notes box, the timer, every dialog they opened. When the
 * capture failed it falls back to the clip alone, which still carries the gaze
 * but not what the participant was doing with the rest of the screen.
 */
export default function ThinkAloudScreen({ videoId, onComplete }: Props) {
  const { t } = useTranslation()
  const replay = useVideoReplay(videoId)
  const notes = useVideoNotes(videoId)

  if (replay.isLoading || notes.isLoading) {
    return <div className="fullpage">{t('common.loading')}</div>
  }
  if (replay.isError || !replay.data) {
    return <div className="fullpage is-danger">{t('session.error')}</div>
  }

  return (
    <div className="think-aloud">
      <header className="think-aloud__head">
        <h2>{t('think_aloud.title')}</h2>
        <p className="muted">{t('think_aloud.hint')}</p>
      </header>

      <ReplayPlayer replay={replay.data} notes={notes.data ?? []} />

      <footer className="think-aloud__foot">
        <span className="muted">
          {t('think_aloud.stats', { points: replay.data.plotted_points })}
          {replay.data.source === 'clip' ? ` · ${t('think_aloud.clip_only')}` : ''}
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
  const videoRef = useRef<HTMLVideoElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<HTMLDivElement>(null)
  const [showGaze, setShowGaze] = useState(true)
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

  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      const dot = dotRef.current
      if (!video || !dot) return

      const g = showGazeRef.current ? gazeAt(replay.points, video.currentTime * 1000) : null
      if (!g) {
        dot.style.opacity = '0'
      } else {
        // Points are normalised to the picture — the whole display on a screen
        // recording, the clip's frame on a clip replay. Either way they belong
        // inside the picture, not the element, which letterboxes it.
        const { left, top } = frameToElement(
          g,
          { width: video.clientWidth, height: video.clientHeight },
          { width: video.videoWidth, height: video.videoHeight },
        )
        dot.style.opacity = '1'
        dot.style.left = `${left}px`
        dot.style.top = `${top}px`
      }
      if (notesRef.current) {
        notesRef.current.textContent = textAt(timeline, video.currentTime * 1000)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [replay.points, timeline])

  return (
    <div className="replay">
      <div className="replay__stage">
        <video ref={videoRef} src={url} controls className="replay__video" />
        <div ref={dotRef} className="gaze-dot" aria-hidden="true" />
      </div>
      <aside className="replay__notes">
        <span className="rail-label">{t('think_aloud.notes_label')}</span>
        <div ref={notesRef} className="replay__notes-text" />
        <label className="replay__toggle">
          <input
            type="checkbox"
            checked={showGaze}
            onChange={(e) => setShowGaze(e.target.checked)}
          />
          {t('think_aloud.show_gaze')}
        </label>
      </aside>
    </div>
  )
}
