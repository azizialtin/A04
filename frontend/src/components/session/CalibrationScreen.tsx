import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { gazeApi } from '../../api/gaze'
import {
  CALIBRATION_TARGETS,
  VALIDATION_TARGETS,
  meanGaze,
  meanOffset,
  offsetInDegrees,
  offsetOf,
  toDisplay,
  type Target,
  type ValidationPoint,
} from '../../lib/calibration'
import { Bridge, TOBII_WS_URL, type BridgeGaze } from '../../lib/tobii'

const DWELL_MS = 1200 // time on a calibration target before collecting
const SETTLE_MS = 600 // time to land on a validation target before measuring
const MEASURE_MS = 1000 // time spent measuring one validation target

// Above this the gaze cannot be trusted to tell one region of the clip from
// another, and the run should be recalibrated.
const OFFSET_WARN = 0.05

type Phase = 'connecting' | 'ready' | 'running' | 'done' | 'no_tracker' | 'failed'

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

interface Props {
  onComplete: () => void
}

/**
 * Calibrates the eye tracker, then validates it by measuring the error on four
 * fresh targets. Uncalibrated gaze is not analysable, so this runs once before
 * the first case — and the measured error is stored with the run so a bad
 * calibration can be told apart from a bad participant afterwards.
 *
 * Without a tracker the study manager can skip it; that is recorded too.
 */
export default function CalibrationScreen({ onComplete }: Props) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('connecting')
  const [target, setTarget] = useState<Target | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState<{ offset: number | null; degrees: number | null } | null>(null)
  const [error, setError] = useState('')

  const bridgeRef = useRef<Bridge | null>(null)
  const collected = useRef<BridgeGaze[]>([])

  useEffect(() => {
    let cancelled = false
    Bridge.connect(TOBII_WS_URL)
      .then((bridge) => {
        if (cancelled) {
          bridge.close()
          return
        }
        bridgeRef.current = bridge
        bridge.onGaze = (sample) => collected.current.push(sample)
        setPhase(bridge.status.connected ? 'ready' : 'no_tracker')
      })
      .catch(() => {
        if (!cancelled) setPhase('no_tracker')
      })
    return () => {
      cancelled = true
      bridgeRef.current?.close()
      bridgeRef.current = null
    }
  }, [])

  const save = useCallback(
    async (
      status: 'success' | 'failed' | 'skipped',
      points: ValidationPoint[] = [],
      offset: number | null = null,
      degrees: number | null = null,
    ) => {
      try {
        await gazeApi.saveCalibration({
          status,
          mean_offset: offset,
          mean_offset_degrees: degrees,
          points,
        })
      } catch {
        // Losing the record is bad but blocking the session on it is worse;
        // the run itself carries on.
      }
    },
    [],
  )

  const measure = useCallback(async (at: Target, aspect: number) => {
    setTarget(at)
    await wait(SETTLE_MS)
    collected.current = []
    await wait(MEASURE_MS)

    const samples = collected.current.slice()
    const display = toDisplay(at)
    const gaze = meanGaze(samples)
    const point: ValidationPoint = {
      target_x: display.x,
      target_y: display.y,
      gaze_x: gaze?.x ?? null,
      gaze_y: gaze?.y ?? null,
      offset: gaze ? offsetOf(display, gaze, aspect) : null,
      samples: samples.filter((s) => s.x !== null).length,
    }
    const distances = samples.map((s) => s.dz).filter((d): d is number => d !== null)
    return { point, distance: distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null }
  }, [])

  const run = useCallback(async () => {
    const bridge = bridgeRef.current
    if (!bridge) return

    setPhase('running')
    setError('')
    try {
      await document.documentElement.requestFullscreen?.().catch(() => {})

      const started = await bridge.request('calibrate_start', 'calibration_started')
      if (!started.ok) throw new Error(t('calibration.error_start'))

      setProgress({ done: 0, total: CALIBRATION_TARGETS.length + VALIDATION_TARGETS.length })
      for (const [i, at] of CALIBRATION_TARGETS.entries()) {
        setTarget(at)
        await wait(DWELL_MS)
        const display = toDisplay(at)
        const res = await bridge.request('calibrate_point', 'calibration_point_result', {
          x: display.x,
          y: display.y,
        })
        if (!res.ok) throw new Error(t('calibration.error_point'))
        setProgress({ done: i + 1, total: CALIBRATION_TARGETS.length + VALIDATION_TARGETS.length })
      }

      const computed = await bridge.request('calibrate_compute', 'calibration_result')
      if (!computed.ok) throw new Error(t('calibration.error_compute'))

      // Validation runs off the ordinary gaze stream, on targets the tracker
      // was not calibrated against.
      bridge.send('start_gaze')
      const aspect = (window.screen.width || 16) / (window.screen.height || 9)
      const points: ValidationPoint[] = []
      const distances: number[] = []
      for (const [i, at] of VALIDATION_TARGETS.entries()) {
        const { point, distance } = await measure(at, aspect)
        points.push(point)
        if (distance !== null) distances.push(distance)
        setProgress({
          done: CALIBRATION_TARGETS.length + i + 1,
          total: CALIBRATION_TARGETS.length + VALIDATION_TARGETS.length,
        })
      }
      bridge.send('stop_gaze')
      setTarget(null)

      const offset = meanOffset(points)
      const degrees = offsetInDegrees(
        offset,
        bridge.status.display_w_mm,
        distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null,
      )
      await save('success', points, offset, degrees)
      setResult({ offset, degrees })
      setPhase('done')
    } catch (err) {
      bridge.send('calibrate_abort')
      setTarget(null)
      setError(err instanceof Error ? err.message : t('calibration.error_generic'))
      await save('failed')
      setPhase('failed')
    } finally {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    }
  }, [measure, save, t])

  const skip = useCallback(async () => {
    await save('skipped')
    onComplete()
  }, [onComplete, save])

  if (phase === 'running' && target) {
    return (
      <div className="calibration calibration--targets">
        <div
          className="calibration__target"
          style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%` }}
        />
        <p className="calibration__counter">
          {t('calibration.progress', { current: progress.done + 1, total: progress.total })}
        </p>
      </div>
    )
  }

  return (
    <div className="fullpage">
      <div className="panel panel--narrow">
        <h1>{t('calibration.title')}</h1>

        {phase === 'connecting' && <p className="muted">{t('calibration.connecting')}</p>}

        {phase === 'ready' && (
          <>
            <p className="muted">{t('calibration.intro')}</p>
            <button type="button" className="btn btn-primary btn-lg" onClick={() => void run()}>
              {t('calibration.start')}
            </button>
          </>
        )}

        {phase === 'running' && <p className="muted">{t('calibration.working')}</p>}

        {phase === 'no_tracker' && (
          <>
            <p className="muted">{t('calibration.no_tracker')}</p>
            <div className="panel__actions">
              <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
                {t('calibration.retry')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void skip()}>
                {t('calibration.skip')}
              </button>
            </div>
          </>
        )}

        {phase === 'failed' && (
          <>
            <p className="error-text">{error}</p>
            <div className="panel__actions">
              <button type="button" className="btn btn-secondary" onClick={() => void run()}>
                {t('calibration.repeat')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void skip()}>
                {t('calibration.skip')}
              </button>
            </div>
          </>
        )}

        {phase === 'done' && result && (
          <>
            <p className="muted">
              {result.degrees !== null
                ? t('calibration.accuracy_degrees', { value: result.degrees.toFixed(2) })
                : t('calibration.accuracy_fraction', {
                    value: ((result.offset ?? 0) * 100).toFixed(1),
                  })}
            </p>
            {(result.offset ?? 0) > OFFSET_WARN && (
              <p className="error-text">{t('calibration.poor')}</p>
            )}
            <div className="panel__actions">
              <button type="button" className="btn btn-secondary" onClick={() => void run()}>
                {t('calibration.repeat')}
              </button>
              <button type="button" className="btn btn-primary btn-lg" onClick={onComplete}>
                {t('calibration.continue')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
