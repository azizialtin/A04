import { beginStimulusAudio, type StimulusCapture } from './stimulusAudio'

const CHUNK_BYTES = 64 * 1024
const MAX_QUEUED_BYTES = 4 * 1024 * 1024
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

export interface BridgeAudioRecording {
  beginSending(): void
  fail(message: string): void
  stop(): Promise<void>
}

/** Stream only the case video's encoded sound over the owning screen socket. */
export function startBridgeAudio(ws: WebSocket): BridgeAudioRecording {
  const capture = beginStimulusAudio()
  let recorder: MediaRecorder | null = null
  let epochMs = 0
  let recordingStarted = false
  let sending = false
  let stopped = false
  let transferClosed = false
  let queuedBytes = 0
  let chunks: Blob[] = []
  let chain = Promise.resolve()
  let finishRecorder: () => void = () => {}
  const recorderStopped = new Promise<void>((resolve) => (finishRecorder = resolve))
  let readyToSend: () => void = () => {}
  const bridgeReady = new Promise<void>((resolve) => (readyToSend = resolve))

  const sendChunks = () => {
    if (!sending || !epochMs) return
    const batch = chunks
    chunks = []
    for (const blob of batch) {
      chain = chain
        .then(async () => {
          for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
            const bytes = await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer()
            if (
              transferClosed ||
              ws.readyState !== WebSocket.OPEN ||
              ws.bufferedAmount > MAX_QUEUED_BYTES
            ) {
              throw new Error('The bridge audio connection was lost or could not keep up')
            }
            ws.send(bytes)
          }
          queuedBytes -= blob.size
        })
        .catch((error: unknown) => capture.fail(String(error)))
    }
  }
  const begin = () => {
    if (transferClosed || sending || !recordingStarted || !epochMs || !recorder) return
    if (ws.readyState !== WebSocket.OPEN) {
      capture.fail('The bridge audio connection closed before capture began')
      readyToSend()
      return
    }
    try {
      ws.send(
        JSON.stringify({
          type: 'start_stimulus_audio',
          epoch_ms: epochMs,
          mime_type: recorder.mimeType,
        }),
      )
      sending = true
      sendChunks()
    } catch {
      capture.fail('The bridge could not start receiving stimulus audio')
    }
    readyToSend()
  }
  let allowed = false
  try {
    if (!capture.stream) throw new Error('No stimulus audio stream')
    const mimeType = AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error('This browser has no supported stimulus audio encoder')
    recorder = new MediaRecorder(capture.stream, { mimeType, audioBitsPerSecond: 128_000 })
    recorder.onstart = () => {
      recordingStarted = true
      if (allowed) begin()
    }
    recorder.ondataavailable = ({ data }) => {
      if (transferClosed || !data.size) return
      queuedBytes += data.size
      if (queuedBytes > MAX_QUEUED_BYTES) {
        capture.fail('The bridge could not receive the stimulus audio in time')
        return
      }
      chunks.push(data)
      sendChunks()
    }
    recorder.onstop = () => {
      if (!stopped) capture.fail('The stimulus audio encoder ended before the case was complete')
      finishRecorder()
    }
    recorder.onerror = () => {
      capture.fail('The stimulus audio encoder failed')
    }
    // The encoder's queued start event is not the beginning of its timeline.
    epochMs = Date.now()
    recorder.start(1000)
  } catch (error) {
    capture.fail(String(error))
    finishRecorder()
    readyToSend()
  }
  let delivery: Promise<void> | null = null
  return {
    beginSending: () => {
      allowed = true
      begin()
    },
    fail: (message) => {
      capture.fail(message)
      if (!sending) readyToSend()
    },
    stop: () => {
      delivery ??= finish()
      return delivery
    },
  }

  async function finish() {
    if (stopped) return
    stopped = true
    if (recorder?.state !== 'inactive') {
      try {
        recorder?.stop()
      } catch {
        capture.fail('The stimulus audio encoder could not flush its final packets')
        finishRecorder()
      }
    }
    await bounded(recorderStopped, capture, 'The stimulus audio encoder did not finish')
    capture.finish()
    await bounded(bridgeReady, capture, 'The bridge never acknowledged the screen recording')
    sendChunks()
    await bounded(chain, capture, 'The stimulus audio transfer did not finish')
    transferClosed = true
    const metadata = capture.snapshot()
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'finish_stimulus_audio', ...metadata }))
    }
  }
}

async function bounded(promise: Promise<void>, capture: StimulusCapture, error: string) {
  let timer = 0
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = window.setTimeout(() => {
        capture.fail(error)
        resolve()
      }, 10_000)
    }),
  ])
  window.clearTimeout(timer)
}
