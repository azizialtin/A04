import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import apiClient from '../../api/client'
import { participantApi } from '../../api/participant'
import { useGazeCapture } from '../../hooks/useGazeCapture'
import { useScreenRecording } from '../../hooks/useScreenRecording'
import { enqueue } from '../../lib/outbox'

interface Props {
  videoId: number
  onTimeUpdate?: (seconds: number) => void
  onEnded?: () => void
}

/**
 * Plays a case clip and logs playback events. The event stream (started /
 * paused / resumed / seeked / completed, each carrying currentTime) is what the
 * think-aloud replay later uses to map wall-clock samples onto the timeline.
 */
export default function VideoPlayer({ videoId, onTimeUpdate, onEnded }: Props) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // Stream eye tracking for as long as the clip is on screen (no-op without the
  // lab bridge). It reads the element to record where the clip sits on screen.
  useGazeCapture(videoId, videoRef)
  // And record the screen for the same stretch, which is what the think-aloud
  // plays back. Also a no-op without the bridge.
  useScreenRecording(videoId)

  const started = useRef(false)
  const ended = useRef(false)
  const lastTime = useRef(0)
  const seekFrom = useRef<number | null>(null)

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

  if (failed) return <div className="video-error">{t('video.error')}</div>
  if (!url) return <div className="video-loading">{t('common.loading')}</div>

  return (
    <video
      ref={videoRef}
      src={url}
      className="case-video__el"
      controls
      controlsList="nodownload"
      onContextMenu={(e) => e.preventDefault()}
      onPlay={onPlay}
      onPause={() => {
        if (!ended.current) fire('video_paused')
      }}
      onSeeking={() => {
        if (seekFrom.current === null) seekFrom.current = lastTime.current
      }}
      onSeeked={onSeeked}
      onTimeUpdate={onTime}
      onEnded={() => {
        if (ended.current) return
        ended.current = true
        fire('video_completed')
        onEnded?.()
      }}
      aria-label={t('case.video_label')}
    />
  )
}
