import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'

import apiClient from '../../api/client'
import { participantApi } from '../../api/participant'
import { useScreenRecording } from '../../hooks/useScreenRecording'
import { enqueue } from '../../lib/outbox'

interface Props {
  videoId: number
  onTimeUpdate?: (seconds: number) => void
  onEnded?: () => void
}

/** Move the scrubber: the handle position, and the played-so-far fill behind it. */
function paint(bar: HTMLInputElement, current: number, duration: number) {
  bar.value = String(current)
  bar.style.setProperty('--played', `${duration > 0 ? (current / duration) * 100 : 0}%`)
}

/**
 * Plays a case clip and logs playback events. The event stream (started /
 * paused / resumed / seeked / completed, each carrying currentTime) is what the
 * think-aloud replay later uses to map wall-clock samples onto the timeline.
 *
 * The controls are ours rather than the browser's, and deliberately just two:
 * play/pause and the scrubber. The native bar also carries volume, playback
 * rate, picture-in-picture and fullscreen — each one a way to watch the case
 * under conditions the study did not intend, and none of them something the
 * analysis could tell had happened. The think-aloud replay keeps the native
 * controls: there the participant is reviewing their own run, not being
 * measured on it.
 */
export default function VideoPlayer({ videoId, onTimeUpdate, onEnded }: Props) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const scrubRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)

  // The case's display capture is the background for its think-aloud replay.
  useScreenRecording(videoId)

  const started = useRef(false)
  const ended = useRef(false)
  const lastTime = useRef(0)
  const seekFrom = useRef<number | null>(null)
  // While the participant drags the handle the playhead is theirs; the repaint
  // loop must not pull it back to wherever the clip has got to.
  const scrubbing = useRef(false)

  useEffect(() => {
    let cancelled = false
    participantApi
      .getVideoUrl(videoId)
      .then((res) => {
        if (cancelled) return
        const u = res.signed_url
        setUrl(u.startsWith('/') ? `${apiClient.defaults.baseURL}${u}` : u)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [videoId])

  // Follow the playhead at screen rate rather than off `timeupdate`, which
  // fires about four times a second and leaves the handle visibly stuttering.
  // Written straight to the element: sixty React renders a second to move one
  // bar is work the notes box and the gaze capture would rather have.
  useEffect(() => {
    if (!url) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      const bar = scrubRef.current
      if (!video || !bar || scrubbing.current) return
      paint(bar, video.currentTime, video.duration || 0)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [url])

  const fire = useCallback(
    (eventType: string, extra: Record<string, unknown> = {}) => {
      // Through the outbox: losing one of these loses a playback span, and with
      // it the gaze mapping for that stretch of the clip.
      enqueue('event', {
        event_type: eventType,
        video_id: videoId,
        // Stamped here rather than server-side: the replay lines these events up
        // against gaze samples from the bridge, which runs on this same machine.
        client_ts: Date.now(),
        payload: { currentTime: videoRef.current?.currentTime ?? 0, ...extra },
      })
    },
    [videoId],
  )

  const onPlay = () => {
    setPlaying(true)
    if (!started.current) {
      started.current = true
      fire('video_started')
      return
    }
    if (ended.current) {
      ended.current = false
      fire('video_replayed')
    }
    fire('video_resumed')
  }

  const onSeeked = () => {
    const to = videoRef.current?.currentTime ?? 0
    fire('video_seeked', { from: seekFrom.current ?? 0, to })
    seekFrom.current = null
    lastTime.current = to
  }

  const onTime = () => {
    const v = videoRef.current
    if (!v) return
    if (!v.seeking && seekFrom.current === null) lastTime.current = v.currentTime
    onTimeUpdate?.(v.currentTime)
  }

  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }

  const scrubTo = (e: ChangeEvent<HTMLInputElement>) => {
    const to = Number(e.target.value)
    paint(e.target, to, duration)
    // Assigning currentTime fires `seeking`/`seeked` on the element, so the
    // event log records this exactly as it recorded a drag on the native bar.
    if (videoRef.current) videoRef.current.currentTime = to
  }

  if (failed) return <div className="video-error">{t('video.error')}</div>
  if (!url) return <div className="video-loading">{t('common.loading')}</div>

  return (
    <div className="case-video">
      <video
        ref={videoRef}
        data-gaze-video
        data-aoi="video"
        src={url}
        className="case-video__el"
        // No `controls`: the two below are the whole surface.
        controlsList="nodownload"
        disablePictureInPicture
        onContextMenu={(e) => e.preventDefault()}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onPlay={onPlay}
        onPause={() => {
          setPlaying(false)
          if (!ended.current) fire('video_paused')
        }}
        onSeeking={() => {
          if (seekFrom.current === null) seekFrom.current = lastTime.current
        }}
        onSeeked={onSeeked}
        onTimeUpdate={onTime}
        onEnded={() => {
          setPlaying(false)
          if (ended.current) return
          ended.current = true
          fire('video_completed')
          onEnded?.()
        }}
        aria-label={t('case.video_label')}
      />

      <div className="case-video__controls" data-aoi="video_controls">
        <button
          type="button"
          className="case-video__play"
          data-aoi="video_play_pause"
          data-aoi-priority="1"
          onClick={toggle}
          aria-label={t(playing ? 'case.pause' : 'case.play')}
          title={t(playing ? 'case.pause' : 'case.play')}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            {playing ? (
              <path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" />
            ) : (
              <path d="M8 5.2v13.6L19 12z" />
            )}
          </svg>
        </button>
        <input
          ref={scrubRef}
          type="range"
          className="case-video__scrub"
          data-aoi="video_seek"
          data-aoi-priority="1"
          min={0}
          max={duration || 0}
          step="any"
          defaultValue={0}
          disabled={!duration}
          onChange={scrubTo}
          onPointerDown={() => (scrubbing.current = true)}
          onPointerUp={() => (scrubbing.current = false)}
          onPointerCancel={() => (scrubbing.current = false)}
          aria-label={t('case.seek')}
        />
      </div>
    </div>
  )
}
