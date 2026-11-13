import { useEffect, useRef, useState } from 'react'

import { gazeApi, type GazeContext, type GazeSample } from '../api/gaze'
import { capturePageGeometry, observePageGeometry } from '../lib/aoi'
import { sameLayout, type GazeLayout } from '../lib/gazeGeometry'
import { openGazeConnection, type GazeHealth } from '../lib/gazeConnection'
import { gazeDeliveryGeneration, reportGazeDelivery } from '../lib/gazeDelivery'
import { enqueue } from '../lib/outbox'

const FLUSH_INTERVAL_MS = 2000
const BATCH_SIZE = 500
const MAX_PENDING = 15_000
const MAX_LAYOUTS = 10_000

/** Each measured screen owns its recording, samples, and timestamped DOM layouts. */
export function useGazeCapture(context: GazeContext | null, fallbackRateHz = 120) {
  const [health, setHealth] = useState<GazeHealth>({ state: 'connecting', received: 0, valid: 0 })
  const [issue, setIssue] = useState<'recording_failed' | 'upload_failed' | 'data_lost' | null>(
    null,
  )
  const retry = useRef<() => void>(() => {})
  const videoId = context?.video_id
  const stepKind = context?.step_kind
  const stepIndex = context?.step_index
  const questionnaireId = context?.questionnaire_id

  useEffect(() => {
    if (!stepKind || stepIndex === undefined) return
    let active = true
    const deliveryGeneration = gazeDeliveryGeneration()
    setIssue(null)
    let currentIssue: typeof issue = null
    let currentHealth: GazeHealth = { state: 'connecting', received: 0, valid: 0 }
    let loggedState = ''
    const logTransition = () => {
      if (!active || deliveryGeneration !== gazeDeliveryGeneration()) return
      const key = `${currentHealth.state}:${currentIssue}:${!!currentHealth.mock}:${currentHealth.error_code ?? ''}`
      if (key === loggedState) return
      loggedState = key
      enqueue('event', {
        event_type: 'gaze_capture_status',
        video_id: videoId ?? null,
        client_ts: Date.now(),
        payload: {
          step_kind: stepKind,
          step_index: stepIndex,
          questionnaire_id: questionnaireId ?? null,
          state: currentHealth.state,
          issue: currentIssue,
          error_code: currentHealth.error_code ?? null,
          received: currentHealth.received,
          valid: currentHealth.valid,
          source_mode: currentHealth.mock ? 'mock' : 'tobii_or_legacy',
        },
      })
    }
    const showIssue = (value: typeof issue) => {
      if (!active) return
      currentIssue = value
      setIssue(value)
      logTransition()
    }
    let sampleUploadFailed = false
    let layoutUploadFailed = false
    let lostData = false
    const updateDelivery = () => {
      if (active)
        showIssue(
          lostData
            ? 'data_lost'
            : sampleUploadFailed || layoutUploadFailed
              ? 'upload_failed'
              : null,
        )
    }
    let startRetryTimer = 0
    let startStream: () => void = () => {}
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
    let initialLayout: GazeLayout | null = null
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
        lostData = true
        updateDelivery()
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
            layoutUploadFailed = false
            updateDelivery()
          } catch {
            // Keep the original timestamp; a retry must not move a layout change.
            layoutUploadFailed = true
            updateDelivery()
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
      if (initialLayout !== null && rememberLayout(next)) {
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
            sampleUploadFailed = false
            updateDelivery()
          } catch {
            sampleUploadFailed = true
            updateDelivery()
            retryAt = performance.now() + FLUSH_INTERVAL_MS
            break
          }
        }
      })().finally(() => {
        sampleWork = null
      })
      return sampleWork
    }

    const finalizeRecording = async (id: number) => {
      await Promise.all([sampleWork, layoutWork])
      await Promise.all([flushSamples(true), flushLayouts(true)])
      const unsent = samples.length + (retryBatch?.length ?? 0)
      if (dropped || unsent || layouts.length || droppedLayouts) {
        console.warn(
          `gaze: ${dropped + unsent} samples and ${layouts.length + droppedLayouts} layouts could not be uploaded`,
        )
      }
      if (dropped || unsent || layouts.length || droppedLayouts)
        reportGazeDelivery('upload_failed', deliveryGeneration)
      else if (total === 0) reportGazeDelivery('empty', deliveryGeneration)
      let completionFailed = false
      await gazeApi.completeRecording(id, { sample_count: total }).catch(() => {
        completionFailed = true
        reportGazeDelivery('upload_failed', deliveryGeneration)
      })
      if (deliveryGeneration === gazeDeliveryGeneration())
        enqueue('event', {
          event_type: 'gaze_capture_status',
          video_id: videoId ?? null,
          client_ts: Date.now(),
          payload: {
            step_kind: stepKind,
            step_index: stepIndex,
            questionnaire_id: questionnaireId ?? null,
            state: 'capture_finished',
            issue: completionFailed
              ? 'completion_failed'
              : unsent || dropped || layouts.length || droppedLayouts
                ? 'upload_failed'
                : total === 0
                  ? 'empty'
                  : null,
            saved: total,
            unsent,
            dropped,
            unsaved_layouts: layouts.length + droppedLayouts,
          },
        })
    }

    const createRecording = async (frequency: unknown, start: () => void) => {
      startStream = start
      if (!active) return
      if (recordingId !== null) {
        startStream()
        return
      }
      if (creating) return
      creating = true
      const rate = typeof frequency === 'number' && frequency > 0 ? frequency : fallbackRateHz
      if (initialLayout === null) {
        initialLayout = measure()
        latest = initialLayout
        rememberLayout(initialLayout)
      }
      const initial = initialLayout
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
        recordingId = rec.recording_id
        if (!active) {
          // Discovery may have emitted frames while this request was pending.
          await finalizeRecording(rec.recording_id)
          return
        }
        // Layout may have changed while the start request was in flight.
        syncGeometry()
        updateDelivery()
        startStream()
        void flushSamples()
      } catch {
        if (active) {
          showIssue('recording_failed')
          startRetryTimer = window.setTimeout(() => connection.retry(), 3000)
        }
      } finally {
        creating = false
      }
    }

    const connection = openGazeConnection({
      onHealth: (value) => {
        currentHealth = value
        setHealth(value)
        logTransition()
      },
      onReady: (frequency, start) => {
        void createRecording(frequency, start)
      },
      onSample: (msg) => {
        if (!active) return
        samples.push({
          ts: msg.ts as number,
          lx: typeof msg.lx === 'number' ? msg.lx : null,
          ly: typeof msg.ly === 'number' ? msg.ly : null,
          rx: typeof msg.rx === 'number' ? msg.rx : null,
          ry: typeof msg.ry === 'number' ? msg.ry : null,
          lv: msg.lv === true,
          rv: msg.rv === true,
          lpd: typeof msg.lpd === 'number' ? msg.lpd : null,
          rpd: typeof msg.rpd === 'number' ? msg.rpd : null,
          device_ts: typeof msg.device_ts === 'number' ? msg.device_ts : null,
          geometry_ts: geometryAt(msg.ts as number),
        })
        if (samples.length > MAX_PENDING) {
          samples.shift()
          dropped++
          lostData = true
          updateDelivery()
        }
        if (samples.length >= BATCH_SIZE) void flushSamples()
      },
    })
    retry.current = () => {
      window.clearTimeout(startRetryTimer)
      retryAt = layoutRetryAt = 0
      void flushSamples(true)
      void flushLayouts(true)
      connection.retry()
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
      window.clearTimeout(startRetryTimer)
      retry.current = () => {}
      connection.close()
      if (recordingId === null) return
      const id = recordingId
      void finalizeRecording(id)
    }
  }, [videoId, stepKind, stepIndex, questionnaireId, fallbackRateHz])
  return { ...health, issue, retry: () => retry.current() }
}
