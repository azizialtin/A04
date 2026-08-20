import { useEffect, useRef } from 'react'

import apiClient from '../../api/client'
import type { AdminReplay } from '../../api/admin'
import { frameToElement } from '../../lib/gazeGeometry'
import { gazeAt } from '../../lib/replay'

export default function AdminReplayViewer({ replay, onClose }: { replay: AdminReplay; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)

  const url = replay.video_url.startsWith('/')
    ? `${apiClient.defaults.baseURL}${replay.video_url}`
    : replay.video_url

  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      const dot = dotRef.current
      if (!video || !dot) return
      const g = gazeAt(replay.points, video.currentTime * 1000)
      if (!g) {
        dot.style.opacity = '0'
      } else {
        const { left, top } = frameToElement(
          g,
          { width: video.clientWidth, height: video.clientHeight },
          { width: video.videoWidth, height: video.videoHeight },
        )
        dot.style.opacity = '1'
        dot.style.left = `${left}px`
        dot.style.top = `${top}px`
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [replay.points])

  return (
    <div className="card">
      <div className="flex-between">
        <h3 style={{ margin: 0 }}>
          {replay.participant_id} · {replay.video_title}
        </h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Schließen
        </button>
      </div>
      <div className="replay__stage" style={{ maxWidth: 720, marginTop: 12 }}>
        <video ref={videoRef} src={url} controls className="replay__video" />
        <div ref={dotRef} className="gaze-dot" aria-hidden="true" />
      </div>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        {replay.source === 'screen' ? 'Bildschirmaufzeichnung' : 'nur das Video'} ·{' '}
        {replay.plotted_points} Blickpunkte · {replay.invalid_samples} ungültig ·{' '}
        {replay.unmapped_samples} außerhalb der Aufzeichnung · {replay.offscreen_samples} daneben ·{' '}
        {replay.sampling_rate_hz} Hz
      </p>
      {replay.source === 'clip' && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Für diesen Fall gibt es keine Bildschirmaufzeichnung; zu sehen ist nur der Stimulus, nicht
          was die Testperson sonst am Bildschirm getan hat.
        </p>
      )}
      {replay.source === 'clip' && !replay.has_geometry && (
        <p className="error-text" style={{ fontSize: '0.85rem' }}>
          Ohne Bildschirm-Geometrie aufgezeichnet — die Blickpositionen sind nicht auf das Video
          bezogen und nur als grobe Näherung zu lesen.
        </p>
      )}
    </div>
  )
}
