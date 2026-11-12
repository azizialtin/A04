import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { AudioCaptureMeta } from '../api/screen'
import { startBridgeAudio } from './bridgeAudio'

const capture = vi.hoisted(() => ({
  stream: {} as MediaStream | null,
  fail: vi.fn(),
  snapshot: vi.fn<() => AudioCaptureMeta>(),
  finish: vi.fn(() => ({ audio_status: 'captured', audio_error: null })),
}))
vi.mock('./stimulusAudio', () => ({ beginStimulusAudio: () => capture }))

class Recorder {
  static last: Recorder
  static isTypeSupported = () => true
  state = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  onstart: (() => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  constructor() {
    Recorder.last = this
  }
  start() {
    this.state = 'recording'
    this.onstart?.()
  }
  stop() {
    this.state = 'inactive'
  }
  chunk(size: number, read: () => Promise<unknown>) {
    this.ondataavailable?.({
      data: {
        size,
        slice: (start: number, end: number) => ({
          arrayBuffer: async () => {
            await read()
            return new ArrayBuffer(Math.min(size - start, end - start))
          },
        }),
      } as Blob,
    })
  }
}

let captureError: string | null = null

beforeEach(() => {
  captureError = null
  capture.stream = {} as MediaStream
  capture.fail.mockClear().mockImplementation((error: string) => {
    captureError = error
  })
  capture.snapshot.mockImplementation(() => ({
    audio_status: captureError ? 'failed' : 'captured',
    audio_error: captureError,
  }))
  capture.finish.mockClear()
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('WebSocket', { OPEN: 1 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function socket() {
  return { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket & {
    send: ReturnType<typeof vi.fn>
  }
}

test('waits for screen acknowledgement, then streams ordered bounded chunks and finalizes last', async () => {
  const ws = socket()
  const audio = startBridgeAudio(ws)
  let read!: () => void
  Recorder.last.chunk(
    100_000,
    () =>
      new Promise<void>((resolve) => {
        read = resolve
      }),
  )
  expect(ws.send).not.toHaveBeenCalled()
  audio.beginSending()
  expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
    type: 'start_stimulus_audio',
    mime_type: 'audio/webm;codecs=opus',
  })
  let complete = false
  const stop = audio.stop().then(() => {
    complete = true
  })
  await Promise.resolve()
  expect(complete).toBe(false)
  // Final encoder data is asynchronous and must precede finish_stimulus_audio.
  Recorder.last.onstop?.()
  read()
  await vi.waitFor(() =>
    expect(ws.send.mock.calls.some(([value]) => value instanceof ArrayBuffer)).toBe(true),
  )
  read()
  await stop
  expect(
    ws.send.mock.calls
      .filter(([value]) => value instanceof ArrayBuffer)
      .map(([value]) => value.byteLength),
  ).toEqual([65_536, 34_464])
  expect(JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0])).toMatchObject({
    type: 'finish_stimulus_audio',
    audio_status: 'captured',
  })
  expect(capture.finish).toHaveBeenCalledOnce()
})

test('marks a broken transport failed even when the encoder finishes', async () => {
  const ws = socket()
  const audio = startBridgeAudio(ws)
  audio.beginSending()
  Object.defineProperty(ws, 'bufferedAmount', { value: 5_000_000 })
  Recorder.last.chunk(3, async () => new ArrayBuffer(3))
  const stopped = audio.stop()
  Recorder.last.onstop?.()
  await stopped
  expect(capture.fail).toHaveBeenCalledWith(expect.stringContaining('could not keep up'))
})

test('times out a stalled final read and never sends its late bytes after finalization', async () => {
  vi.useFakeTimers()
  const ws = socket()
  const audio = startBridgeAudio(ws)
  audio.beginSending()
  let release!: () => void
  Recorder.last.chunk(
    3,
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const done = audio.stop()
  Recorder.last.onstop?.()
  await vi.advanceTimersByTimeAsync(10_001)
  await done
  const sent = ws.send.mock.calls.length
  expect(capture.fail).toHaveBeenCalledWith('The stimulus audio transfer did not finish')
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(ws.send).toHaveBeenCalledTimes(sent)
  expect(ws.send.mock.calls.some(([value]) => value instanceof ArrayBuffer)).toBe(false)
})

test('no supported codec fails visibly without hanging finalization', async () => {
  vi.spyOn(Recorder, 'isTypeSupported').mockReturnValue(false)
  const audio = startBridgeAudio(socket())
  await audio.stop()
  expect(capture.fail).toHaveBeenCalledWith(
    expect.stringContaining('no supported stimulus audio encoder'),
  )
  expect(capture.finish).toHaveBeenCalledOnce()
})

test('missing audio API or stream still finalizes without throwing', async () => {
  capture.stream = null
  const audio = startBridgeAudio(socket())
  await audio.stop()
  expect(capture.fail).toHaveBeenCalledWith(expect.stringContaining('No stimulus audio stream'))
})

test('a late screen acknowledgement cannot restart audio after timeout finalization', async () => {
  vi.useFakeTimers()
  const ws = socket()
  const audio = startBridgeAudio(ws)
  const stopped = audio.stop()
  Recorder.last.onstop?.()
  await vi.advanceTimersByTimeAsync(10_001)
  await stopped
  const sent = ws.send.mock.calls.length
  audio.beginSending()
  expect(ws.send).toHaveBeenCalledTimes(sent)
  expect(capture.fail).toHaveBeenCalledWith(expect.stringContaining('never acknowledged'))
})

test('an encoder error preserves its asynchronously emitted final chunk', async () => {
  const ws = socket()
  const audio = startBridgeAudio(ws)
  audio.beginSending()
  Recorder.last.onerror?.()
  const stopped = audio.stop()
  await Promise.resolve()
  expect(capture.finish).not.toHaveBeenCalled()
  Recorder.last.chunk(8, async () => {})
  Recorder.last.onstop?.()
  await stopped
  expect(
    ws.send.mock.calls.some(([data]) => data instanceof ArrayBuffer && data.byteLength === 8),
  ).toBe(true)
  expect(capture.fail).toHaveBeenCalledWith('The stimulus audio encoder failed')
})

test('stopping twice sends one final metadata message', async () => {
  const ws = socket()
  const audio = startBridgeAudio(ws)
  audio.beginSending()
  const first = audio.stop()
  const second = audio.stop()
  expect(second).toBe(first)
  Recorder.last.onstop?.()
  await first
  expect(
    ws.send.mock.calls.filter(
      ([data]) => typeof data === 'string' && JSON.parse(data).type === 'finish_stimulus_audio',
    ),
  ).toHaveLength(1)
})

test('a throwing encoder stop cannot report captured audio from earlier packets', async () => {
  const ws = socket()
  const audio = startBridgeAudio(ws)
  audio.beginSending()
  Recorder.last.chunk(8, async () => {})
  Recorder.last.stop = () => {
    throw new Error('encoder lost')
  }
  await audio.stop()
  expect(capture.fail).toHaveBeenCalledWith(expect.stringContaining('could not flush'))
  expect(JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0])).toMatchObject({
    type: 'finish_stimulus_audio',
    audio_status: 'failed',
  })
})

test('an encoder ending before the case is complete is recorded as an audio failure', async () => {
  const ws = socket()
  const audio = startBridgeAudio(ws)
  audio.beginSending()
  Recorder.last.state = 'inactive'
  Recorder.last.onstop?.()
  await audio.stop()
  expect(capture.fail).toHaveBeenCalledWith(expect.stringContaining('ended before the case'))
  expect(JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0])).toMatchObject({
    type: 'finish_stimulus_audio',
    audio_status: 'failed',
  })
})

test('audio alignment uses the start invocation even when the encoder event arrives late', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1700000000000))
  vi.spyOn(Recorder.prototype, 'start').mockImplementation(function (this: Recorder) {
    this.state = 'recording'
  })
  const ws = socket()
  const audio = startBridgeAudio(ws)
  audio.beginSending()
  expect(ws.send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(300)
  Recorder.last.onstart?.()
  expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
    type: 'start_stimulus_audio',
    epoch_ms: 1700000000000,
  })
  const stopped = audio.stop()
  Recorder.last.onstop?.()
  await stopped
})
