import { useEffect } from 'react'

import { gazeApi, type GazeContext, type GazeSample } from '../api/gaze'
import { capturePageGeometry, observePageGeometry } from '../lib/aoi'
import { sameLayout, type GazeLayout } from '../lib/gazeGeometry'
import { TOBII_WS_URL } from '../lib/tobii'

const FLUSH_INTERVAL_MS = 2000
const BATCH_SIZE = 500
const MAX_PENDING = 15_000
const MAX_LAYOUTS = 10_000

/** Each measured screen owns its recording, samples, and timestamped DOM layouts. */
export function useGazeCapture(context: GazeContext | null, fallbackRateHz = 120) {
  const videoId = context?.video_id
  const stepKind = context?.step_kind
  const stepIndex = context?.step_index
  const questionnaireId = context?.questionnaire_id

  useEffect(() => {
    if (!stepKind || stepIndex === undefined) return
    let active = true
    let creating = false
    let recordingId: number | null = null
    let total = 0
    let dropped = 0
    let retryAt = 0
    let layoutRetryAt = 0
    let droppedLayouts = 0
    let unavailableFrom: number | null = null
    let newestMeasurement: number | null = null
    let clockUncertain = false
    const samples: GazeSample[] = []
    let retryBatch: GazeSample[] | null = null
    const layouts: GazeLayout[] = []
    const observed: number[] = []
    const timestampCounts = new Map<number, number>()
    let latest: GazeLayout | null = null
    let sampleWork: Promise<void> | null = null
    let layoutWork: Promise<void> | null = null

    const measure = () => {
      const next = capturePageGeometry()
      if (newestMeasurement !== null && next.ts < newestMeasurement) clockUncertain = true
      newestMeasurement = Math.max(newestMeasurement ?? next.ts, next.ts)
      return next
    }

    const rememberLayout = (next: GazeLayout) => {
      if (observed.length >= MAX_LAYOUTS) {
        unavailableFrom = Math.min(unavailableFrom ?? next.ts, next.ts)
        droppedLayouts++
        return false
      }
      observed.push(next.ts)
      if (next.ts < observed[observed.length - 2]) observed.sort((a, b) => a - b)
      timestampCounts.set(next.ts, (timestampCounts.get(next.ts) ?? 0) + 1)
      return true
    }

    const geometryAt = (timestamp: number): number | null => {
      if (clockUncertain || (unavailableFrom !== null && timestamp >= unavailableFrom)) return null
      let low = 0
      let high = observed.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (observed[middle] <= timestamp) low = middle + 1
        else high = middle
      }
      const snapshot = observed[low - 1]
      return snapshot !== undefined && timestampCounts.get(snapshot) === 1 ? snapshot : null
    }

    const flushLayouts = (final = false): Promise<void> => {
      if (layoutWork) return layoutWork
      const id = recordingId
      if (id === null || !layouts.length || (!final && performance.now() < layoutRetryAt)) {
        return Promise.resolve()
      }
      layoutWork = (async () => {
        while (layouts.length) {
          const next = layouts[0]
          try {
            await gazeApi.addGeometry(id, next)
            layouts.shift()
          } catch {
            // Keep the original timestamp; a retry must not move a layout change.
            layoutRetryAt = performance.now() + FLUSH_INTERVAL_MS
            break
          }
        }
      })().finally(() => {
        layoutWork = null
      })
      return layoutWork
    }

    const syncGeometry = () => {
      const next = measure()
      // Two changes in one millisecond cannot be distinguished by their timestamp.
      // A later measurement of the stable layout restores an unambiguous anchor.
      const reanchor =
        latest !== null && (timestampCounts.get(latest.ts) ?? 0) > 1 && next.ts > latest.ts
      if (sameLayout(latest, next) && !reanchor) return
      latest = next
      if (recordingId !== null && rememberLayout(next)) {
        layouts.push(next)
        void flushLayouts()
      }
    }

    const flushSamples = (final = false): Promise<void> => {
      if (sampleWork) return sampleWork
      const id = recordingId
      if (
        id === null ||
        (!retryBatch && !samples.length) ||
        (!final && performance.now() < retryAt)
      ) {
        return Promise.resolve()
      }
      sampleWork = (async () => {
        while (retryBatch || samples.length) {
          // A lost response must retry exactly the same payload and offset,
          // even when newer samples overflow the pending queue.
          const batch = retryBatch ?? samples.splice(0, BATCH_SIZE)
          retryBatch = batch
          try {
            await gazeApi.uploadSamples(id, batch, total)
            total += batch.length
            retryBatch = null
          } catch {
            retryAt = performance.now() + FLUSH_INTERVAL_MS
            break
          }
        }
      })().finally(() => {
        sampleWork = null
      })
      return sampleWork
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(TOBII_WS_URL)
    } catch {
      return undefined
    }

    const createRecording = async (frequency: unknown) => {
      if (!active || creating || recordingId !== null) return
      creating = true
      const rate = typeof frequency === 'number' && frequency > 0 ? frequency : fallbackRateHz
      const initial = measure()
      latest = initial
      try {
        const rec = await gazeApi.startRecording({
          video_id: videoId ?? null,
          step_kind: stepKind,
          step_index: stepIndex,
          questionnaire_id: questionnaireId ?? null,
          sampling_rate_hz: rate,
          geometry: initial,
        })
        if (typeof rec.recording_id !== 'number') throw new Error('Missing gaze recording ID')
        if (!active) {
          await gazeApi.completeRecording(rec.recording_id, { sample_count: 0 }).catch(() => {})
          return
        }
        recordingId = rec.recording_id
        rememberLayout(initial)
        // Layout may have changed while the start request was in flight.
        latest = initial
        syncGeometry()
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'start_gaze' }))
      } catch {
        ws.close()
      } finally {
        creating = false
      }
    }

    ws.onmessage = (event) => {
      if (!active) return
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'status') {
          if (msg.connected) void createRecording(msg.frequency)
          return
        }
        if (msg.type !== 'gaze' || recordingId === null || !Number.isFinite(msg.ts)) return
        samples.push({
          ts: msg.ts,
          lx: msg.lx ?? null,
          ly: msg.ly ?? null,
          rx: msg.rx ?? null,
          ry: msg.ry ?? null,
          lv: msg.lv === true,
          rv: msg.rv === true,
          lpd: msg.lpd ?? null,
          rpd: msg.rpd ?? null,
          device_ts: msg.device_ts ?? null,
          geometry_ts: geometryAt(msg.ts),
        })
        if (samples.length > MAX_PENDING) {
          samples.shift()
          dropped++
        }
        if (samples.length >= BATCH_SIZE) void flushSamples()
      } catch {
        // A malformed bridge frame must not interrupt the participant.
      }
    }

    const stopObserving = observePageGeometry(syncGeometry)
    const timer = window.setInterval(() => {
      void flushLayouts()
      void flushSamples()
    }, FLUSH_INTERVAL_MS)

    return () => {
      active = false
      stopObserving()
      window.clearInterval(timer)
      ws.onmessage = null
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop_gaze' }))
        ws.close()
      } catch {
        // The bridge may already have disconnected.
      }
      if (recordingId === null) return
      const id = recordingId
      void (async () => {
        await Promise.all([sampleWork, layoutWork])
        await Promise.all([flushSamples(true), flushLayouts(true)])
        const unsent = samples.length + (retryBatch?.length ?? 0)
        if (dropped || unsent || layouts.length || droppedLayouts) {
          console.warn(
            `gaze: ${dropped + unsent} samples and ${layouts.length + droppedLayouts} layouts could not be uploaded`,
          )
        }
        await gazeApi.completeRecording(id, { sample_count: total }).catch(() => {})
      })()
    }
  }, [videoId, stepKind, stepIndex, questionnaireId, fallbackRateHz])
}
