import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { screenApi } from '../api/screen'
import { useScreenRecording } from './useScreenRecording'
import { audioWarning, setAudioWarning } from '../lib/stimulusAudio'

vi.mock('../api/screen', () => ({
  screenApi: {
    start: vi.fn(),
    markFailed: vi.fn(),
    uploadUrl: (id: number) => `http://api.test/screen/recordings/${id}/upload`,
    failedUrl: (id: number) => `http://api.test/screen/recordings/${id}/failed`,
    sessionUrl: (id: number) => `http://api.test/screen/recordings/${id}/upload-url`,
    completeUrl: (id: number) => `http://api.test/screen/recordings/${id}/complete`,
  },
}))

// The page's own capture, for when the bridge is not there. Stubbed: what it
// does is its own test's business; here only *when* it is asked matters.
const browserRecording = { stop: vi.fn().mockResolvedValue(undefined) }
const startBrowserRecording = vi.fn<(videoId: number, stream: unknown) => typeof browserRecording>(
  () => browserRecording,
)
let held: object | null = null
let bridgeFailed = false
const noteBridgeCaptureFailed = vi.fn(() => {
  bridgeFailed = true
})
vi.mock('../lib/screenCapture', () => ({
  heldStream: () => held,
  hasBridgeCaptureFailed: () => bridgeFailed,
  noteBridgeCaptureFailed: () => noteBridgeCaptureFailed(),
  startBrowserRecording: (videoId: number, stream: unknown) =>
    startBrowserRecording(videoId, stream),
}))

const bridgeAudio = vi.hoisted(() => ({
  beginSending: vi.fn(),
  fail: vi.fn(),
  stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))
vi.mock('../lib/bridgeAudio', () => ({ startBridgeAudio: () => bridgeAudio }))

const start = vi.mocked(screenApi.start)
const markFailed = vi.mocked(screenApi.markFailed)

/** Just enough WebSocket for the hook: it opens one, sends, and closes. */
class FakeSocket {
  static last: FakeSocket | null = null
  // The hook compares against WebSocket.OPEN, which is a static on the real class.
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeSocket.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: Record<string, unknown>[] = []
  closed = false

  constructor() {
    FakeSocket.last = this
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }

  close() {
    this.closed = true
  }

  /** Pretend the bridge said something. */
  say(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

beforeEach(() => {
  FakeSocket.last = null
  setAudioWarning(null)
  bridgeAudio.beginSending.mockClear()
  bridgeAudio.fail.mockClear()
  bridgeAudio.stop.mockReset().mockResolvedValue(undefined)
  held = null
  bridgeFailed = false
  noteBridgeCaptureFailed.mockClear()
  startBrowserRecording.mockClear()
  browserRecording.stop.mockClear()
  vi.stubGlobal('WebSocket', FakeSocket)
  start.mockReset().mockResolvedValue({ recording_id: 7, upload_token: 'tok' })
  markFailed.mockReset().mockResolvedValue({} as never)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('asks the bridge to record once it says it can', async () => {
  renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', connected: true, screen_recording: true })

  await waitFor(() => expect(FakeSocket.last!.sent).toHaveLength(1))
  expect(start).toHaveBeenCalledWith(42, 'bridge')
  expect(FakeSocket.last!.sent[0]).toEqual({
    type: 'start_screen_recording',
    upload_url: 'http://api.test/screen/recordings/7/upload',
    // Where a bucket exists the capture goes straight there; the backend only
    // hands out the session and is told what landed.
    session_url: 'http://api.test/screen/recordings/7/upload-url',
    complete_url: 'http://api.test/screen/recordings/7/complete',
    failed_url: 'http://api.test/screen/recordings/7/failed',
    token: 'tok',
  })
})

test('does not open a recording when the bridge cannot capture', async () => {
  renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', connected: true, screen_recording: false })

  await Promise.resolve()
  expect(start).not.toHaveBeenCalled()
  // ...and with no display granted, the page cannot step in either.
  expect(startBrowserRecording).not.toHaveBeenCalled()
})

test('records in the browser when the bridge cannot capture but the display was granted', () => {
  held = { fake: 'stream' }
  const { unmount } = renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', connected: true, screen_recording: false })

  expect(startBrowserRecording).toHaveBeenCalledWith(42, held)
  expect(start).not.toHaveBeenCalled() // the browser path opens its own row

  unmount()
  expect(browserRecording.stop).toHaveBeenCalledTimes(1)
})

test('records in the browser when the bridge is not there at all', () => {
  held = { fake: 'stream' }
  renderHook(() => useScreenRecording(42))
  // A refused connection: the socket errors and closes before any status.
  FakeSocket.last!.onerror?.()
  FakeSocket.last!.onclose?.()

  expect(startBrowserRecording).toHaveBeenCalledTimes(1)
})

test('the bridge wins once it has said it will record', async () => {
  held = { fake: 'stream' }
  renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  await waitFor(() => expect(start).toHaveBeenCalledWith(42, 'bridge'))

  // A later close is the bridge going away, not a reason to start a second capture.
  FakeSocket.last!.onclose?.()
  expect(startBrowserRecording).not.toHaveBeenCalled()
})

test('stops the capture when the case screen goes away', async () => {
  const { unmount } = renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  await waitFor(() => expect(FakeSocket.last!.sent).toHaveLength(1))

  const socket = FakeSocket.last!
  unmount()

  expect(socket.sent[1]).toEqual({ type: 'stop_screen_recording' })
  expect(socket.closed).toBe(true)
})

test('marks the recording failed when the bridge will not start', async () => {
  renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  await waitFor(() => expect(start).toHaveBeenCalled())

  FakeSocket.last!.say({ type: 'screen_recording_started', ok: false, error: 'no ffmpeg' })
  expect(markFailed).toHaveBeenCalledWith(7, 'no ffmpeg')
  // Remembered, so the next case intro secures the display instead of losing
  // the whole session to the same fault.
  expect(noteBridgeCaptureFailed).toHaveBeenCalled()
})

test('uses the granted browser display on the next case after a bridge capture failure', async () => {
  const { rerender, unmount } = renderHook(({ videoId }) => useScreenRecording(videoId), {
    initialProps: { videoId: 42 },
  })
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  await waitFor(() => expect(FakeSocket.last!.sent).toHaveLength(1))
  FakeSocket.last!.say({
    type: 'screen_recording_started',
    ok: false,
    error: 'screen capture permission refused',
  })

  // The next intro has obtained the fallback display, but ffmpeg is still
  // installed, so the bridge continues to advertise screen_recording: true.
  held = { fake: 'granted display' }
  rerender({ videoId: 43 })
  FakeSocket.last!.say({ type: 'status', screen_recording: true })

  expect(startBrowserRecording).toHaveBeenCalledWith(43, held)
  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith(42, 'bridge')
  expect(FakeSocket.last!.sent).toEqual([])

  unmount()
  expect(browserRecording.stop).toHaveBeenCalledOnce()
})

test('closes out a recording opened after the case already ended', async () => {
  let release: (v: { recording_id: number; upload_token: string }) => void = () => {}
  start.mockReturnValue(new Promise((resolve) => (release = resolve)))

  const { unmount } = renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  unmount()
  release({ recording_id: 9, upload_token: 'tok' })

  // Otherwise the row sits at "recording" for a capture that never began.
  await waitFor(() => expect(markFailed).toHaveBeenCalledWith(9, expect.stringContaining('ended')))
})

test('stays out of the way when there is no bridge and no display', () => {
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        throw new Error('connection refused')
      }
    },
  )
  expect(() => renderHook(() => useScreenRecording(42))).not.toThrow()
  expect(start).not.toHaveBeenCalled()
  expect(startBrowserRecording).not.toHaveBeenCalled()
})

test('finishes audio before stopping the screen and closing its socket', async () => {
  let finish!: () => void
  bridgeAudio.stop.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    }),
  )
  const { unmount } = renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true, stimulus_audio: true })
  await waitFor(() => expect(FakeSocket.last!.sent).toHaveLength(1))
  const socket = FakeSocket.last!
  socket.say({ type: 'screen_recording_started', ok: true })
  expect(bridgeAudio.beginSending).toHaveBeenCalledOnce()
  unmount()
  expect(socket.closed).toBe(false)
  expect(socket.sent).toHaveLength(1)
  finish()
  await waitFor(() => expect(socket.closed).toBe(true))
  expect(socket.sent[1]).toEqual({ type: 'stop_screen_recording' })
})

test('old bridges report a visible audio update warning', async () => {
  renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  await waitFor(() => expect(audioWarning()).toBe('bridge_update'))
})

test('a rejected audio stream is marked failed while the case can continue', async () => {
  renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true, stimulus_audio: true })
  await waitFor(() => expect(FakeSocket.last!.sent).toHaveLength(1))
  FakeSocket.last!.say({ type: 'stimulus_audio_error', error: 'corrupt audio' })
  expect(bridgeAudio.fail).toHaveBeenCalledWith('corrupt audio')
})

test('times out bridge startup, warns and releases the audio encoder', async () => {
  vi.useFakeTimers()
  renderHook(() => useScreenRecording(42))
  const socket = FakeSocket.last!
  await act(async () => {
    socket.say({ type: 'status', screen_recording: true, stimulus_audio: true })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_001)
  })
  expect(markFailed).toHaveBeenCalledWith(7, expect.stringContaining('acknowledge'))
  expect(bridgeAudio.fail).toHaveBeenCalledWith(expect.stringContaining('acknowledge'))
  expect(bridgeAudio.stop).toHaveBeenCalled()
  expect(socket.closed).toBe(true)
  expect(audioWarning()).toBe('failed')
})

test('a connection lost while the server creates a row never starts a new audio encoder', async () => {
  let opened!: (value: { recording_id: number; upload_token: string }) => void
  start.mockReturnValue(
    new Promise((resolve) => {
      opened = resolve
    }),
  )
  renderHook(() => useScreenRecording(42))
  const socket = FakeSocket.last!
  socket.say({ type: 'status', screen_recording: true, stimulus_audio: true })
  socket.readyState = FakeSocket.CLOSED
  socket.onclose?.()
  opened({ recording_id: 7, upload_token: 'tok' })
  await waitFor(() => expect(markFailed).toHaveBeenCalledWith(7, expect.stringContaining('closed')))
  expect(socket.sent).toEqual([])
  expect(bridgeAudio.beginSending).not.toHaveBeenCalled()
})

test('a backend failure completing after unmount cannot replace the next case warning', async () => {
  let reject!: (error: Error) => void
  start.mockReturnValue(
    new Promise((_resolve, no) => {
      reject = no
    }),
  )
  const { unmount } = renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', screen_recording: true })
  unmount()
  setAudioWarning('silent')
  reject(new Error('offline'))
  await Promise.resolve()
  expect(audioWarning()).toBe('silent')
})

test('a throwing websocket send still closes the socket and marks its row failed', async () => {
  renderHook(() => useScreenRecording(42))
  const socket = FakeSocket.last!
  vi.spyOn(socket, 'send').mockImplementation(() => {
    throw new Error('disconnected')
  })
  socket.say({ type: 'status', screen_recording: true, stimulus_audio: true })
  await waitFor(() => expect(socket.closed).toBe(true))
  expect(markFailed).toHaveBeenCalledWith(7, expect.stringContaining('closed'))
  expect(bridgeAudio.stop).toHaveBeenCalled()
})

test('a late status cannot create a recording after the case was unmounted', async () => {
  const { unmount } = renderHook(() => useScreenRecording(42))
  const socket = FakeSocket.last!
  unmount()
  socket.say({ type: 'status', screen_recording: true, stimulus_audio: true })
  await Promise.resolve()
  expect(start).not.toHaveBeenCalled()
})
