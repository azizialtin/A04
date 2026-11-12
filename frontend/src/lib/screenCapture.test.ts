import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { screenApi } from '../api/screen'
import {
  _reset,
  bridgeCanRecord,
  ensureDisplayStream,
  hasBridgeCaptureFailed,
  heldStream,
  noteBridgeCaptureFailed,
  prepareCapture,
  startBrowserRecording,
  uploadSettled,
} from './screenCapture'

vi.mock('../api/screen', () => ({
  screenApi: {
    start: vi.fn(),
    markFailed: vi.fn(),
    deliver: vi.fn(),
  },
}))

const audio = vi.hoisted(() => ({
  stream: null as MediaStream | null,
  finish: vi.fn(() => ({ audio_status: 'captured', audio_error: null })),
  snapshot: vi.fn(() => ({ audio_status: 'captured', audio_error: null })),
  fail: vi.fn(),
}))
vi.mock('./stimulusAudio', () => ({
  prepareStimulusAudio: vi.fn(),
  beginStimulusAudio: () => audio,
}))

const start = vi.mocked(screenApi.start)
const markFailed = vi.mocked(screenApi.markFailed)
const deliver = vi.mocked(screenApi.deliver)

/** Just enough WebSocket for the probe: it opens one and waits for `status`. */
class FakeSocket {
  static last: FakeSocket | null = null
  static readonly OPEN = 1
  readyState = FakeSocket.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor() {
    FakeSocket.last = this
  }
  send() {}
  close() {
    this.closed = true
  }
  say(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

class FakeTrack extends EventTarget {
  kind = 'video'
  readyState: 'live' | 'ended' = 'live'
  getSettings() {
    return { width: 1920, height: 1080 }
  }
  stop() {
    this.readyState = 'ended'
  }
  end() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeStream {
  constructor(public tracks = [new FakeTrack()]) {}
  getVideoTracks() {
    return this.tracks
  }
  getTracks() {
    return this.tracks
  }
}

/** A MediaRecorder that hands out one chunk and stops when told. */
class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported = (type: string) => type.startsWith('video/webm')
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstart: (() => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(
    public stream: unknown,
    options: { mimeType?: string },
  ) {
    this.mimeType = options.mimeType ?? ''
    FakeRecorder.instances.push(this)
  }
  start() {
    this.state = 'recording'
    this.onstart?.()
    this.ondataavailable?.({ data: new Blob(['frames'], { type: 'video/webm' }) })
  }
  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }
}

let getDisplayMedia: ReturnType<typeof vi.fn>

beforeEach(() => {
  _reset()
  audio.stream = null
  audio.finish.mockClear()
  audio.fail.mockClear()
  FakeSocket.last = null
  FakeRecorder.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('MediaStream', FakeStream)
  getDisplayMedia = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia },
  })
  start.mockReset().mockResolvedValue({ recording_id: 7, upload_token: 'tok' })
  markFailed.mockReset().mockResolvedValue({} as never)
  deliver.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('the bridge is asked whether it will record', async () => {
  const answer = bridgeCanRecord()
  FakeSocket.last!.say({ type: 'status', connected: false, screen_recording: true })
  expect(await answer).toBe(true)
  expect(FakeSocket.last!.closed).toBe(true)
})

test('no bridge means no recording from the bridge', async () => {
  const answer = bridgeCanRecord()
  FakeSocket.last!.onclose?.()
  expect(await answer).toBe(false)
})

test('the display is asked for once and kept for the whole page', async () => {
  const stream = new FakeStream()
  getDisplayMedia.mockResolvedValue(stream)

  expect(await ensureDisplayStream()).toBe(stream)
  expect(await ensureDisplayStream()).toBe(stream)
  expect(getDisplayMedia).toHaveBeenCalledTimes(1)
  expect(heldStream()).toBe(stream)
})

test('a refusal is remembered rather than asked again every case', async () => {
  getDisplayMedia.mockRejectedValue(new Error('NotAllowedError'))

  expect(await ensureDisplayStream()).toBeNull()
  expect(await ensureDisplayStream()).toBeNull()
  expect(getDisplayMedia).toHaveBeenCalledTimes(1)
})

test('stopping the share from the browser bar forgets the stream', async () => {
  const stream = new FakeStream()
  getDisplayMedia.mockResolvedValue(stream)
  await ensureDisplayStream()

  stream.tracks[0].end()
  expect(heldStream()).toBeNull()
})

test('preparing a capture leaves the display alone when the bridge will record', async () => {
  const prepared = prepareCapture()
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  await prepared
  expect(getDisplayMedia).not.toHaveBeenCalled()
})

test('preparing a capture takes the display when there is no bridge', async () => {
  getDisplayMedia.mockResolvedValue(new FakeStream())
  const prepared = prepareCapture()
  FakeSocket.last!.onerror?.()
  await prepared
  expect(getDisplayMedia).toHaveBeenCalledTimes(1)
})

test('a bridge capture failure secures the browser display for following cases', async () => {
  const prepared = prepareCapture()
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  await prepared
  expect(getDisplayMedia).not.toHaveBeenCalled()

  noteBridgeCaptureFailed()
  const stream = new FakeStream()
  getDisplayMedia.mockResolvedValue(stream)
  await prepareCapture()

  expect(hasBridgeCaptureFailed()).toBe(true)
  expect(getDisplayMedia).toHaveBeenCalledOnce()
  expect(heldStream()).toBe(stream)
})

test('a browser recording is opened as such and delivered when stopped', async () => {
  const stream = new FakeStream() as unknown as MediaStream
  const recording = startBrowserRecording(42, stream)!
  expect(recording).not.toBeNull()
  expect(start).toHaveBeenCalledWith(42, 'browser')
  expect(FakeRecorder.instances[0].mimeType).toBe('video/webm;codecs=vp9,opus')

  const settled = uploadSettled(42)
  await recording.stop()
  await settled

  expect(deliver).toHaveBeenCalledTimes(1)
  const [recordingId, token, blob, meta] = deliver.mock.calls[0]
  expect(recordingId).toBe(7)
  expect(token).toBe('tok')
  expect((blob as Blob).type).toBe('video/webm')
  // The clock anchor is the browser's, and the frame size travels along.
  expect(meta.epoch_ms).toBeGreaterThan(0)
  expect(meta.width).toBe(1920)
  expect(meta.height).toBe(1080)
})

test('a delivery that fails marks the row failed', async () => {
  deliver.mockRejectedValue(new Error('bucket said 500'))
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  await recording.stop()
  expect(markFailed).toHaveBeenCalledWith(7, expect.stringContaining('upload failed'))
})

test('nothing waits on a case that was never recorded', async () => {
  await expect(uploadSettled(99)).resolves.toBeUndefined()
})

test('records only stimulus audio alongside display video and keeps the held tracks alive', async () => {
  const videoTrack = Object.assign(new EventTarget(), {
    kind: 'video',
    stop: vi.fn(),
    getSettings: () => ({}),
  })
  const systemTrack = { kind: 'audio', stop: vi.fn() }
  const stimulusTrack = { kind: 'audio', stop: vi.fn() }
  const display = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [systemTrack],
  } as unknown as MediaStream
  audio.stream = { getAudioTracks: () => [stimulusTrack] } as unknown as MediaStream
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(public tracks: unknown[]) {}
    },
  )
  const recording = startBrowserRecording(42, display)!
  expect(FakeRecorder.instances[0].stream).toEqual({ tracks: [videoTrack, stimulusTrack] })
  await recording.stop()
  expect(deliver.mock.calls[0][3]).toMatchObject({ audio_status: 'captured', audio_error: null })
  expect(videoTrack.stop).not.toHaveBeenCalled()
  expect(stimulusTrack.stop).not.toHaveBeenCalled()
})

test('reports encoder failure separately from video upload success', async () => {
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  FakeRecorder.instances[0].onerror?.()
  await recording.stop()
  expect(audio.fail).toHaveBeenCalledWith('MediaRecorder reported a capture error')
  expect(audio.finish).toHaveBeenCalled()
})

test('an asynchronous encoder error waits for its final data and stop event', async () => {
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  const recorder = FakeRecorder.instances[0]
  recorder.stop = () => {
    recorder.state = 'inactive'
  }
  recorder.onerror?.()
  const stopped = recording.stop()
  await Promise.resolve()
  expect(deliver).not.toHaveBeenCalled()
  recorder.ondataavailable?.({ data: new Blob(['final-packet']) })
  recorder.onstop?.()
  await stopped
  expect(deliver.mock.calls[0][2].size).toBe('framesfinal-packet'.length)
})

test('a stopped display is flagged and cannot extend the recording through audio alone', async () => {
  const stream = new FakeStream()
  const recording = startBrowserRecording(42, stream as unknown as MediaStream)!
  stream.tracks[0].end()
  expect(FakeRecorder.instances[0].state).toBe('inactive')
  expect(audio.fail).toHaveBeenCalledWith('Display sharing ended before the case was complete')
  await recording.stop()
  expect(deliver).toHaveBeenCalledOnce()
})

test('a recorder that never flushes fails within a bound instead of hanging replay', async () => {
  vi.useFakeTimers()
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  FakeRecorder.instances[0].stop = () => {
    FakeRecorder.instances[0].state = 'inactive'
  }
  const stopped = recording.stop()
  await vi.advanceTimersByTimeAsync(10_001)
  await stopped
  expect(markFailed).toHaveBeenCalledWith(7, expect.stringContaining('10 seconds'))
  expect(deliver).not.toHaveBeenCalled()
  await expect(uploadSettled(42)).resolves.toBeUndefined()
})

test('a stop exception marks the unfinished file failed', async () => {
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  FakeRecorder.instances[0].stop = () => {
    throw new Error('encoder lost')
  }
  await recording.stop()
  expect(markFailed).toHaveBeenCalledWith(7, expect.stringContaining('could not finish'))
  expect(deliver).not.toHaveBeenCalled()
})

test('synchronous start failures tolerate a failed status-report request', async () => {
  vi.spyOn(FakeRecorder.prototype, 'start').mockImplementation(() => {
    throw new Error('permission lost')
  })
  markFailed.mockRejectedValue(new Error('offline'))
  expect(startBrowserRecording(42, new FakeStream() as unknown as MediaStream)).toBeNull()
  await vi.waitFor(() => expect(markFailed).toHaveBeenCalled())
  expect(audio.fail).toHaveBeenCalledWith('MediaRecorder would not start')
})

test.each(['video/mp4', 'video/x-matroska'])(
  'preserves a supported container family (%s) at upload',
  async (mimeType) => {
    const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
    FakeRecorder.instances[0].mimeType = mimeType
    await recording.stop()
    expect(deliver.mock.calls[0][2].type).toBe(
      mimeType === 'video/mp4' ? 'video/mp4' : 'video/webm',
    )
  },
)

test('does not disguise an unknown container as WebM', async () => {
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  FakeRecorder.instances[0].mimeType = 'video/unsupported'
  await recording.stop()
  expect(markFailed).toHaveBeenCalledWith(
    7,
    expect.stringContaining('Unsupported recording format'),
  )
  expect(deliver).not.toHaveBeenCalled()
})

test('refuses an ended display without creating a server recording', () => {
  const stream = new FakeStream()
  stream.tracks[0].end()
  expect(startBrowserRecording(42, stream as unknown as MediaStream)).toBeNull()
  expect(start).not.toHaveBeenCalled()
  expect(audio.finish).toHaveBeenCalled()
})

test('stops idempotently while an upload is in flight', async () => {
  let deliverDone!: () => void
  deliver.mockReturnValue(
    new Promise<void>((resolve) => {
      deliverDone = resolve
    }),
  )
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  const first = recording.stop()
  const second = recording.stop()
  expect(first).toBe(second)
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
  deliverDone()
  await first
})

test('screen permission excludes all computer audio', async () => {
  getDisplayMedia.mockResolvedValue(new FakeStream())
  await ensureDisplayStream()
  expect(getDisplayMedia.mock.calls[0][0]).toMatchObject({
    audio: false,
    video: { displaySurface: 'monitor' },
  })
})

test('a wrong surface is released and can be corrected at the next intro', async () => {
  const wrong = new FakeStream()
  wrong.tracks[0].getSettings = () => ({ width: 100, height: 100, displaySurface: 'window' })
  getDisplayMedia.mockResolvedValueOnce(wrong).mockResolvedValueOnce(new FakeStream())
  expect(await ensureDisplayStream()).toBeNull()
  expect(wrong.tracks[0].readyState).toBe('ended')
  expect(await ensureDisplayStream()).not.toBeNull()
  expect(getDisplayMedia).toHaveBeenCalledTimes(2)
})

test('a late permission grant after timeout is released instead of leaking screen sharing', async () => {
  vi.useFakeTimers()
  let grant!: (stream: FakeStream) => void
  getDisplayMedia.mockReturnValue(
    new Promise((resolve) => {
      grant = resolve
    }),
  )
  const pending = ensureDisplayStream()
  await vi.advanceTimersByTimeAsync(90_001)
  expect(await pending).toBeNull()
  const late = new FakeStream()
  grant(late)
  await Promise.resolve()
  expect(late.tracks[0].readyState).toBe('ended')
  expect(heldStream()).toBeNull()
})

test('a delayed encoder start event cannot shift gaze timestamps or recording duration', async () => {
  vi.useFakeTimers()
  let monotonic = 0
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  vi.setSystemTime(new Date(1700000000000))
  vi.spyOn(FakeRecorder.prototype, 'start').mockImplementation(function (this: FakeRecorder) {
    this.state = 'recording'
    window.setTimeout(() => {
      this.onstart?.()
      this.ondataavailable?.({ data: new Blob(['frames'], { type: 'video/webm' }) })
    }, 300)
  })
  const recording = startBrowserRecording(42, new FakeStream() as unknown as MediaStream)!
  await vi.advanceTimersByTimeAsync(1000)
  monotonic = 1000
  await recording.stop()
  expect(deliver.mock.calls[0][3]).toMatchObject({ epoch_ms: 1700000000000, duration_ms: 1000 })
})
