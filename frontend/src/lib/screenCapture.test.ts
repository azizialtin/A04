import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { screenApi } from '../api/screen'
import {
  _reset,
  bridgeCanRecord,
  ensureDisplayStream,
  heldStream,
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
  readyState: 'live' | 'ended' = 'live'
  getSettings() {
    return { width: 1920, height: 1080 }
  }
  end() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeStream {
  tracks = [new FakeTrack()]
  getVideoTracks() {
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
  FakeSocket.last = null
  FakeRecorder.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  getDisplayMedia = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia },
  })
  start.mockReset().mockResolvedValue({ recording_id: 7, upload_token: 'tok' })
  markFailed.mockReset().mockResolvedValue({} as never)
  deliver.mockReset().mockResolvedValue(undefined)
})

afterEach(() => vi.unstubAllGlobals())

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

test('a browser recording is opened as such and delivered when stopped', async () => {
  const stream = new FakeStream() as unknown as MediaStream
  const recording = startBrowserRecording(42, stream)!
  expect(recording).not.toBeNull()
  expect(start).toHaveBeenCalledWith(42, 'browser')
  expect(FakeRecorder.instances[0].mimeType).toBe('video/webm;codecs=vp9')

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
