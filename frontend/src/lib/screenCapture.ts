import { screenApi } from '../api/screen'
import { TOBII_WS_URL } from './tobii'

/**
 * The page's own screen capture, for when no bridge can record.
 *
 * The bridge is the intended recorder: ffmpeg on the lab machine draws the
 * cursor and shares the clock the gaze samples are stamped with. But a test
 * run on a laptop has no bridge, and a lab machine can lose it — and the
 * think-aloud is worth far more over a recording of the screen than over the
 * clip alone, gaze or no gaze. So when the bridge is missing or says it cannot
 * capture, the browser records its own display instead.
 *
 * Two things a browser capture cannot do as well. It needs the participant to
 * grant it once per page load, through the browser's own picker — asked for on
 * the case intro, before the clip, so the case itself is never interrupted.
 * And its clock anchor is `Date.now()` when the recorder reports it has
 * started, which trails the first frame by a frame or two; the notes and any
 * gaze land on the same wall clock, so they still line up to within that.
 */

const PROBE_TIMEOUT_MS = 2000
// Short enough that a bridge started mid-session is noticed by the next case.
// A participant who reads the intro for longer simply re-probes inside the
// click, which costs 2 s at most — well within the gesture's lifetime.
const PROBE_CACHE_MS = 10_000
const PICKER_TIMEOUT_MS = 90_000
const TARGET_FPS = 30
const MAX_HEIGHT = 1080
const BITS_PER_SECOND = 2_500_000
// A chunk a second: nothing sits in one giant buffer, and a crash mid-case
// still leaves most of the capture assembled.
const TIMESLICE_MS = 1000
const OPEN_ATTEMPTS = 2
const OPEN_RETRY_MS = 500

// Cheapest first among what MediaRecorder implementations actually offer.
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
]

let held: MediaStream | null = null
let declined = false
let bridgeFailedOnce = false
let probe: { at: number; answer: Promise<boolean> } | null = null
const uploads = new Map<number, Promise<void>>()

/** Ask the bridge whether it will record the screen. False on no bridge. */
export function bridgeCanRecord(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (probe && Date.now() - probe.at < PROBE_CACHE_MS) return probe.answer
  const answer = askBridge(timeoutMs)
  probe = { at: Date.now(), answer }
  return answer
}

function askBridge(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(TOBII_WS_URL)
    } catch {
      resolve(false)
      return
    }
    const done = (answer: boolean) => {
      window.clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* already gone */
      }
      resolve(answer)
    }
    const timer = window.setTimeout(() => done(false), timeoutMs)
    ws.onerror = () => done(false)
    ws.onclose = () => done(false)
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'status') done(!!msg.screen_recording)
      } catch {
        /* not the handshake */
      }
    }
  })
}

/**
 * The bridge said it could record and then could not.
 *
 * It answers `screen_recording` on nothing more than ffmpeg being on PATH, so
 * the failures that matter — a capture device it cannot resolve, a refused
 * screen-recording permission — only surface once a case has already started,
 * far too late to show a picker. Remembering it means the case after this one
 * secures the display instead of losing the whole session to the same fault.
 */
export function noteBridgeCaptureFailed(): void {
  bridgeFailedOnce = true
}

/** The display stream the page already holds, if it is still live. */
export function heldStream(): MediaStream | null {
  if (held && held.getVideoTracks().some((t) => t.readyState === 'live')) return held
  held = null
  return null
}

export function canCaptureHere(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined'
  )
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      /* already stopped */
    }
  }
}

/**
 * Get the participant's display, asking once per page load. Must be called
 * from a click: the browser will not show its picker otherwise.
 *
 * A refusal is remembered rather than asked again nine times. A timeout and a
 * wrongly-picked surface are not refusals — those may be asked again at the
 * next case, because the participant would have wanted to say yes.
 */
export async function ensureDisplayStream(): Promise<MediaStream | null> {
  const live = heldStream()
  if (live) return live
  if (declined || !canCaptureHere()) return null

  const picker = navigator.mediaDevices.getDisplayMedia({
    video: {
      // The whole screen, like the bridge: the tracker reports gaze against
      // the display, so that is the only surface a sample lands on directly.
      displaySurface: 'monitor',
      frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
      height: { max: MAX_HEIGHT },
    } as MediaTrackConstraints,
    audio: false,
    // Chrome-only hints; other browsers ignore unknown members.
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions)

  // Never hang the run on a picker nobody is going to answer.
  let timer = 0
  const gaveUp = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), PICKER_TIMEOUT_MS)
  })
  try {
    const stream = await Promise.race([picker, gaveUp])
    if (!stream) {
      // The picker is still open. Answered later, nothing would be reading the
      // stream and the browser's "you are sharing" bar would sit there for the
      // rest of the session, so shut it down when it arrives.
      void picker.then(stopStream, () => {})
      return null
    }

    // `displaySurface` above is a hint the participant can overrule. Gaze is
    // reported against the whole display and drawn straight onto the
    // recording, so a window or a tab would put every point on the wrong
    // pixels with nothing downstream able to tell. No recording beats a
    // misleading one, and the next case asks again.
    const surface = (stream.getVideoTracks()[0]?.getSettings() as { displaySurface?: string })
      ?.displaySurface
    if (surface && surface !== 'monitor') {
      console.warn(`screen capture: ${surface} chosen rather than the whole screen; not recording`)
      stopStream(stream)
      return null
    }

    held = stream
    // "Stop sharing" in the browser's own bar ends the track; forget it so
    // the next intro asks again rather than recording nothing.
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (held === stream) held = null
      })
    }
    return stream
  } catch {
    declined = true
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * Make sure a capture is possible before a case starts: nothing to do when
 * the bridge will record, otherwise take the display now, while the click
 * that brought us here still counts as the participant's gesture.
 */
export async function prepareCapture(): Promise<void> {
  if (!canCaptureHere() || heldStream()) return
  if (!bridgeFailedOnce && (await bridgeCanRecord())) return
  await ensureDisplayStream()
}

function pickMimeType(): string {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

/** Open the backend row, retrying once: a blip here would discard a whole case. */
async function openRecording(videoId: number) {
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
    try {
      return await screenApi.start(videoId, 'browser')
    } catch {
      if (attempt < OPEN_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS))
      }
    }
  }
  console.warn(`screen capture: could not open a recording for case ${videoId}`)
  return null
}

export interface BrowserRecording {
  /** Stop capturing and upload what was recorded. Resolves once uploaded (or given up). */
  stop(): Promise<void>
}

/**
 * Record one case off the held stream. Opens the recording with the backend
 * the same way the bridge path does — the row says it was the browser — and
 * delivers the file when stopped. Best-effort throughout: a failure marks the
 * row failed and never reaches the participant.
 */
export function startBrowserRecording(
  videoId: number,
  stream: MediaStream,
): BrowserRecording | null {
  if (!canCaptureHere()) return null
  let recorder: MediaRecorder
  try {
    const mimeType = pickMimeType()
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: BITS_PER_SECOND,
    })
  } catch {
    return null
  }

  const chunks: Blob[] = []
  let epochMs = 0
  let startedAt = 0
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  recorder.onstart = () => {
    // Position 0 of the file is now, give or take the first frame.
    epochMs = Date.now()
    startedAt = performance.now()
  }

  const opened = openRecording(videoId)
  try {
    recorder.start(TIMESLICE_MS)
  } catch {
    void opened.then(
      (o) => o && screenApi.markFailed(o.recording_id, 'MediaRecorder would not start'),
    )
    return null
  }

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.onerror = () => resolve()
  })

  const finish = async () => {
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        /* already stopped */
      }
    }
    await stopped
    const durationMs = startedAt ? Math.round(performance.now() - startedAt) : 0
    const started = await opened
    if (!started) return
    if (!chunks.length || !epochMs) {
      await screenApi
        .markFailed(started.recording_id, 'the browser capture produced no frames')
        .catch(() => {})
      return
    }
    // Normalised to something the backend stores under a real extension: some
    // browsers report the WebM family as x-matroska, and a file saved as .mp4
    // that is not one will not play back.
    const reported = (recorder.mimeType || chunks[0].type || '').split(';')[0]
    const type = reported === 'video/mp4' ? reported : 'video/webm'
    const blob = new Blob(chunks, { type })
    const { width, height } = stream.getVideoTracks()[0]?.getSettings() ?? {}
    try {
      await screenApi.deliver(started.recording_id, started.upload_token, blob, {
        epoch_ms: epochMs,
        duration_ms: durationMs,
        width: width ?? null,
        height: height ?? null,
        fps: TARGET_FPS,
      })
    } catch (err) {
      await screenApi
        .markFailed(started.recording_id, `upload failed: ${String(err).slice(0, 200)}`)
        .catch(() => {})
    }
  }

  // One delivery per recording however often stop() is called: a second run
  // would send the whole capture again and then be refused by the backend.
  let delivery: Promise<void> | null = null
  return {
    stop: () => {
      if (!delivery) {
        delivery = finish().finally(() => {
          if (uploads.get(videoId) === delivery) uploads.delete(videoId)
        })
        uploads.set(videoId, delivery)
      }
      return delivery
    },
  }
}

/** Resolves once any browser capture of this case has been delivered. */
export function uploadSettled(videoId: number): Promise<void> {
  return uploads.get(videoId) ?? Promise.resolve()
}

/** For tests: forget everything this module remembers. */
export function _reset(): void {
  held = null
  declined = false
  bridgeFailedOnce = false
  probe = null
  uploads.clear()
}
