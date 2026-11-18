import { useLayoutEffect, useRef, useState } from 'react'

import { gazeApi, type GazeContext, type GazeSample } from '../api/gaze'
import { capturePageGeometry, observePageGeometry } from '../lib/aoi'
import { sameLayout, type GazeLayout } from '../lib/gazeGeometry'
import { openGazeConnection, type GazeHealth } from '../lib/gazeConnection'
import { gazeDeliveryGeneration, reportGazeDelivery } from '../lib/gazeDelivery'
import { enqueue } from '../lib/outbox'
import {
  currentNativeViewport,
  getNativeViewportSnapshot,
  nativeSampleMatches,
  NATIVE_VIEWPORT_PROFILE,
} from '../lib/nativeViewport'
import {
  displayGuardAllowsSample,
  getDisplayGuardSnapshot,
  subscribeDisplayGuard,
} from '../lib/displayGuard'

const FLUSH_INTERVAL_MS = 2000
const BATCH_SIZE = 500
const MAX_PENDING = 15_000
const MAX_LAYOUTS = 10_000
// A bounded recovery policy, not a claim about what caused a clock adjustment.
const CLOCK_STEP_TOLERANCE_MS = 100

/** Only the video screen owns a gaze subscription and timestamped DOM layouts. */
export function useGazeCapture(context: GazeContext | null, fallbackRateHz = 120) {
  const [mappingVerified, setMappingVerified] = useState<boolean | null>(null)
  const [health, setHealth] = useState<GazeHealth>({ state: 'connecting', received: 0, valid: 0 })
  const [issue, setIssue] = useState<'recording_failed' | 'upload_failed' | 'data_lost' | null>(
    null,
  )
  const retry = useRef<() => void>(() => {})
  const videoId = context?.video_id
  const stepKind = context?.step_kind
  const stepIndex = context?.step_index

  // Stop synchronously at the screen commit, before another screen can be painted.
  useLayoutEffect(() => {
    if (
      stepKind !== 'case_video' ||
      videoId === undefined ||
      !Number.isInteger(videoId) ||
      videoId <= 0 ||
      stepIndex === undefined ||
      !Number.isInteger(stepIndex) ||
      stepIndex < 0
    )
      return
    let active = true
    const enteredAt = Date.now()
    let mappedSample: boolean | null = null
    setMappingVerified(null)
    // Whether admitted samples say anything about AOI assignment at all.
    const mappingTracked = () =>
      getNativeViewportSnapshot().capable || getDisplayGuardSnapshot().enabled
    const reportMapping = (value: boolean | null) => {
      if (!active || mappedSample === value) return
      mappedSample = value
      setMappingVerified(value)
    }
    const deliveryGeneration = gazeDeliveryGeneration()
    setIssue(null)
    let currentIssue: typeof issue = null
    let currentHealth: GazeHealth = { state: 'connecting', received: 0, valid: 0 }
    let loggedState = ''
    let clockUncertain = false
    const logTransition = () => {
      if (!active || deliveryGeneration !== gazeDeliveryGeneration()) return
      const key = `${currentHealth.state}:${currentIssue}:${!!currentHealth.mock}:${currentHealth.error_code ?? ''}:${clockUncertain}`
      if (key === loggedState) return
      loggedState = key
      enqueue('event', {
        event_type: 'gaze_capture_status',
        video_id: videoId ?? null,
        client_ts: Date.now(),
        payload: {
          step_kind: stepKind,
          step_index: stepIndex,
          state: currentHealth.state,
          issue: currentIssue,
          error_code: currentHealth.error_code ?? null,
          received: currentHealth.received,
          valid: currentHealth.valid,
          source_mode: currentHealth.mock ? 'mock' : 'tobii_or_legacy',
          clock_uncertain: clockUncertain,
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
    let newestClockReading = enteredAt
    let earliestVideoTimestamp = enteredAt
    let uncertainThrough: number | null = null
    let clockGuardThrough = enteredAt
    let needsClockAnchor = false
    let lastClockReading = enteredAt
    let clockRollbacks = 0
    const samples: GazeSample[] = []
    let retryBatch: GazeSample[] | null = null
    const layouts: GazeLayout[] = []
    const observed: number[] = []
    const timestampCounts = new Map<number, number>()
    const nativeLayoutProofs = new Map<number, { id?: string; verified: boolean }>()
    let latest: GazeLayout | null = null
    let initialLayout: GazeLayout | null = null
    let sampleWork: Promise<void> | null = null
    let layoutWork: Promise<void> | null = null

    // Watch both layout measurements and sample receipts. Remember uncertainty by
    // timestamp: catching up at receipt time cannot make a delayed sample trustworthy.
    const clockBehind = (now: number) => {
      // A step back is counted once, by the first reading lower than the one before it.
      // The readings that follow while the clock catches up are not new steps.
      if (now < lastClockReading) clockRollbacks++
      lastClockReading = now
      if (now >= newestClockReading) {
        newestClockReading = now
        return false
      }
      needsClockAnchor = true
      // Browser and bridge clocks can adjust independently. Wait beyond the full
      // tolerance and take a fresh DOM snapshot before resuming any AOI mapping.
      clockGuardThrough = Math.max(clockGuardThrough, newestClockReading + CLOCK_STEP_TOLERANCE_MS)
      uncertainThrough = Math.max(uncertainThrough ?? clockGuardThrough, clockGuardThrough)
      // Near entry, a repeated timestamp can name either a stale frame or a real
      // video sample. Preserve that bounded overlap as raw/unmapped data.
      earliestVideoTimestamp = Math.min(
        earliestVideoTimestamp,
        newestClockReading - CLOCK_STEP_TOLERANCE_MS,
      )
      if (newestClockReading - now > CLOCK_STEP_TOLERANCE_MS && !clockUncertain) {
        clockUncertain = true
        logTransition()
      }
      return true
    }

    const measure = () => {
      const next = capturePageGeometry()
      // A tolerated step must not order a newer layout before the one it replaced.
      if (clockBehind(next.ts) && !clockUncertain) next.ts = newestClockReading
      return next
    }

    const canRecoverClockAt = (timestamp: number) =>
      needsClockAnchor &&
      !clockUncertain &&
      uncertainThrough !== null &&
      timestamp > uncertainThrough

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
      nativeLayoutProofs.set(next.ts, {
        id: next.native_viewport?.id,
        verified: next.display_guard?.verified === true && next.visible !== false,
      })
      if (canRecoverClockAt(next.ts)) {
        // This applies to the initial snapshot too, when tracker discovery is late.
        // Guard the new measurement against bridge clock lead, retaining the cutoff
        // so delayed frames cannot inherit the recovered layout.
        uncertainThrough = Math.max(uncertainThrough ?? next.ts, next.ts + CLOCK_STEP_TOLERANCE_MS)
        needsClockAnchor = false
      }
      return true
    }

    const geometryAt = (timestamp: number, nativeId?: string): number | null => {
      if (
        clockUncertain ||
        needsClockAnchor ||
        (uncertainThrough !== null && timestamp <= uncertainThrough) ||
        (unavailableFrom !== null && timestamp >= unavailableFrom)
      )
        return null
      let low = 0
      let high = observed.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (observed[middle] <= timestamp) low = middle + 1
        else high = middle
      }
      const snapshot = observed[low - 1]
      return snapshot !== undefined &&
        timestampCounts.get(snapshot) === 1 &&
        (nativeId === undefined ||
          (nativeLayoutProofs.get(snapshot)?.id === nativeId &&
            nativeLayoutProofs.get(snapshot)?.verified === true))
        ? snapshot
        : null
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
      if (!active) return
      const next = measure()
      const clockRecovered = canRecoverClockAt(next.ts)
      // Two changes in one millisecond cannot be distinguished by their timestamp.
      // A later measurement of the stable layout restores an unambiguous anchor.
      const reanchor =
        latest !== null && (timestampCounts.get(latest.ts) ?? 0) > 1 && next.ts > latest.ts
      if (sameLayout(latest, next) && !reanchor && !clockRecovered) return
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
            clock_uncertain: clockUncertain,
            // A tolerated step otherwise shows only as a stretch of unmapped samples.
            clock_rollbacks: clockRollbacks,
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
          video_id: videoId,
          step_kind: stepKind,
          step_index: stepIndex,
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
        if (!active) return
        currentHealth = value
        setHealth(value)
        if (value.state !== 'tracking' && mappingTracked()) reportMapping(false)
        logTransition()
      },
      onReady: (frequency, start) => {
        void createRecording(frequency, start)
      },
      onSample: (msg) => {
        if (!active) return
        const receivedAt = Date.now()
        clockBehind(receivedAt)
        const timestamp = msg.ts as number
        // With a trustworthy clock, reject pre-video frames. A detected rollback
        // can make entry-overlap frames indistinguishable; keep those raw/unmapped.
        if (!clockUncertain && timestamp < earliestVideoTimestamp) return
        if (needsClockAnchor && receivedAt <= clockGuardThrough) {
          // Include ahead-of-browser frames from the rollback/guard window. Freeze
          // this after the guard: extending it on every frame could prevent recovery
          // indefinitely when the bridge clock runs slightly ahead of the browser.
          uncertainThrough = Math.max(uncertainThrough ?? timestamp, timestamp)
        }
        // A new proof never borrows an older DOM layout. Measure now, so samples
        // captured before this measurement remain outside its timestamp boundary.
        const native = currentNativeViewport()
        const usesNative = getNativeViewportSnapshot().capable
        if (usesNative && latest?.native_viewport?.id !== native?.id) syncGeometry()
        const nativeAllowed =
          !usesNative ||
          (latest?.display_guard?.profile === NATIVE_VIEWPORT_PROFILE &&
            latest.display_guard.verified === true &&
            latest.visible !== false &&
            latest.native_viewport?.id === native?.id &&
            nativeSampleMatches(msg, native))
        const geometryReference =
          nativeAllowed && displayGuardAllowsSample(timestamp)
            ? geometryAt(timestamp, usesNative ? native?.id : undefined)
            : null
        reportMapping(mappingTracked() ? geometryReference !== null : null)
        samples.push({
          ts: timestamp,
          lx: typeof msg.lx === 'number' ? msg.lx : null,
          ly: typeof msg.ly === 'number' ? msg.ly : null,
          rx: typeof msg.rx === 'number' ? msg.rx : null,
          ry: typeof msg.ry === 'number' ? msg.ry : null,
          lv: msg.lv === true,
          rv: msg.rv === true,
          lpd: typeof msg.lpd === 'number' ? msg.lpd : null,
          rpd: typeof msg.rpd === 'number' ? msg.rpd : null,
          device_ts: typeof msg.device_ts === 'number' ? msg.device_ts : null,
          ...(usesNative
            ? {
                viewport_id: typeof msg.viewport_id === 'string' ? msg.viewport_id : null,
                viewport_ts:
                  typeof msg.viewport_ts === 'number' && Number.isFinite(msg.viewport_ts)
                    ? msg.viewport_ts
                    : null,
              }
            : {}),
          geometry_ts: geometryReference,
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
    // Never measure recursively during a guard check. Samples are already
    // rejected synchronously; the next frame supplies the verified layout.
    let guardFrame = 0
    const stopGuard = subscribeDisplayGuard(() => {
      if (mappingTracked()) reportMapping(false)
      if (guardFrame) return
      guardFrame = requestAnimationFrame(() => {
        guardFrame = 0
        if (active) syncGeometry()
      })
    })
    const timer = window.setInterval(() => {
      void flushLayouts()
      void flushSamples()
    }, FLUSH_INTERVAL_MS)

    return () => {
      active = false
      stopObserving()
      stopGuard()
      cancelAnimationFrame(guardFrame)
      window.clearInterval(timer)
      window.clearTimeout(startRetryTimer)
      retry.current = () => {}
      connection.close()
      if (recordingId === null) return
      const id = recordingId
      void finalizeRecording(id)
    }
  }, [videoId, stepKind, stepIndex, fallbackRateHz])
  return { ...health, issue, mappingVerified, retry: () => retry.current() }
}
