import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { screenApi } from '../api/screen'
import { useScreenRecording } from './useScreenRecording'

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
  vi.stubGlobal('WebSocket', FakeSocket)
  start.mockReset().mockResolvedValue({ recording_id: 7, upload_token: 'tok' })
  markFailed.mockReset().mockResolvedValue({} as never)
})

afterEach(() => vi.unstubAllGlobals())

test('asks the bridge to record once it says it can', async () => {
  renderHook(() => useScreenRecording(42))
  FakeSocket.last!.say({ type: 'status', connected: true, screen_recording: true })

  await waitFor(() => expect(FakeSocket.last!.sent).toHaveLength(1))
  expect(start).toHaveBeenCalledWith(42)
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

test('stays out of the way when there is no bridge at all', () => {
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
})
