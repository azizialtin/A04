import { useEffect, useRef, type RefObject } from 'react'

import { gazeApi, type GazeSample } from '../api/gaze'
import { captureGeometry, sameLayout, type GazeGeometry } from '../lib/gazeGeometry'
import { TOBII_WS_URL } from '../lib/tobii'

const FLUSH_INTERVAL_MS = 2000
const GEOMETRY_INTERVAL_MS = 1000
const MAX_BUFFER = 500 // stay well under the backend batch cap (1000)
// Roughly two minutes at 120 Hz. Past that the backend has been unreachable
// long enough that holding more costs memory without buying anything back.
const MAX_PENDING = 15_000

/**
 * Streams gaze from the local Tobii bridge to the backend for as long as this
 * hook is mounted (i.e. while a case clip is on screen):
 *   mount  → open the bridge; once it reports a tracker, create a recording
 *            (at the tracker's real rate) and ask it to start sending
 *   stream → buffer frames, batch-upload every 2 s or 500 samples
 *   unmount→ flush the rest and finalise
 *
 * Alongside the samples it keeps the backend told where the clip is on screen,
 * which is what makes a sample placeable on the picture. That is polled rather
 * than pushed from the player, because the layout settles at its own pace —
 * the element mounts once the URL resolves, the frame size arrives with the
 * metadata, and either can change again on a resize.
 *
 * Best-effort: with no bridge or no tracker (e.g. dev machine) it silently
 * no-ops — no empty recording, and the clip is never blocked.
 */
export function useGazeCapture(
  videoId: number,
  videoRef: RefObject<HTMLVideoElement | null>,
  fallbackRateHz = 120,
) {
  const recordingId = useRef<number | null>(null)
  const buffer = useRef<GazeSample[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const total = useRef(0)
  const dropped = useRef(0)
  const layout = useRef<GazeGeometry | null>(null)

  useEffect(() => {
    let cancelled = false
    let creating = false
    total.current = 0
    layout.current = null

    const syncGeometry = () => {
      const geo = captureGeometry(videoRef.current)
      if (!geo || sameLayout(layout.current, geo)) return
      const id = recordingId.current
      // Before the recording exists this just primes the snapshot that
      // startRecording will send.
      layout.current = geo
      if (id != null) void gazeApi.addGeometry(id, geo).catch(() => {})
    }

    // One upload at a time. Two in flight can reach the server out of order,
    // and a batch that fails has to go back at the head of the queue rather
    // than overtake the samples behind it.
    let inFlight: Promise<void> = Promise.resolve()

    const flush = () => {
      inFlight = inFlight.then(async () => {
        const id = recordingId.current
        if (id == null || buffer.current.length === 0) return
        const batch = buffer.current.splice(0, buffer.current.length)
        try {
          await gazeApi.uploadSamples(id, batch)
          total.current += batch.length
        } catch {
          // Keep them for the next attempt, oldest first. If the backend stays
          // down the buffer is capped, and the drop is counted rather than
          // passing unnoticed.
          buffer.current.unshift(...batch)
          const overflow = buffer.current.length - MAX_PENDING
          if (overflow > 0) {
            buffer.current.splice(0, overflow)
            dropped.current += overflow
          }
        }
      })
      return inFlight
    }

    const createRecording = async (ws: WebSocket, frequency: unknown) => {
      if (creating || recordingId.current != null) return
      creating = true
      const rate = typeof frequency === 'number' && frequency > 0 ? frequency : fallbackRateHz
      try {
        layout.current = captureGeometry(videoRef.current) ?? layout.current
        const rec = await gazeApi.startRecording({
          video_id: videoId,
          sampling_rate_hz: rate,
          geometry: layout.current,
        })
        // Guard against response-shape drift — a wrong field would silently
        // no-op every upload (undefined == null).
        if (typeof rec.recording_id !== 'number') {
          throw new Error('startRecording returned no recording_id')
        }
        if (cancelled) {
          await gazeApi.completeRecording(rec.recording_id, { sample_count: 0 }).catch(() => {})
          return
        }
        recordingId.current = rec.recording_id
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'start_gaze' }))
      } catch {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      } finally {
        creating = false
      }
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(TOBII_WS_URL)
    } catch {
      return undefined
    }
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'status') {
          if (msg.connected) void createRecording(ws, msg.frequency)
          return
        }
        if (msg.type !== 'gaze') return
        buffer.current.push({
          ts: msg.ts,
          lx: msg.lx ?? null,
          ly: msg.ly ?? null,
          rx: msg.rx ?? null,
          ry: msg.ry ?? null,
          lv: !!msg.lv,
          rv: !!msg.rv,
          lpd: msg.lpd ?? null,
          rpd: msg.rpd ?? null,
          device_ts: msg.device_ts ?? null,
        })
        if (buffer.current.length >= MAX_BUFFER) void flush()
      } catch {
        /* ignore malformed frame */
      }
    }

    const flushTimer = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS)
    const geometryTimer = window.setInterval(syncGeometry, GEOMETRY_INTERVAL_MS)
    window.addEventListener('resize', syncGeometry)
    syncGeometry()

    return () => {
      cancelled = true
      window.clearInterval(flushTimer)
      window.clearInterval(geometryTimer)
      window.removeEventListener('resize', syncGeometry)

      const activeWs = wsRef.current
      wsRef.current = null
      if (activeWs) {
        try {
          if (activeWs.readyState === WebSocket.OPEN) {
            activeWs.send(JSON.stringify({ type: 'stop_gaze' }))
          }
          activeWs.close()
        } catch {
          /* ignore */
        }
      }

      const id = recordingId.current
      recordingId.current = null
      if (id == null) return

      void (async () => {
        // Wait for whatever is in flight, then make a last attempt at the tail
        // before finalising — a recording cannot take samples once it is
        // complete, so this is the only chance the remainder gets.
        await inFlight.catch(() => {})
        const remaining = buffer.current.splice(0, buffer.current.length)
        if (remaining.length) {
          await gazeApi
            .uploadSamples(id, remaining)
            .then(() => {
              total.current += remaining.length
            })
            .catch(() => {
              dropped.current += remaining.length
            })
        }
        if (dropped.current) {
          console.warn(`gaze: ${dropped.current} samples could not be uploaded`)
        }
        await gazeApi.completeRecording(id, { sample_count: total.current }).catch(() => {})
      })()
    }
  }, [videoId, videoRef, fallbackRateHz])
}
