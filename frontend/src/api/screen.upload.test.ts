import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { screenApi, type ScreenRecordingMeta } from './screen'

const requests = vi.fn<typeof fetch>()
const metadata: ScreenRecordingMeta = {
  epoch_ms: 1700000000123,
  duration_ms: 64000,
  width: 1920,
  height: 1080,
  fps: 30,
  audio_status: 'failed',
  audio_error: 'Audio clock interrupted',
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

beforeEach(() => {
  requests.mockReset()
  vi.stubGlobal('fetch', requests)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('browser heartbeat uses the same-origin recording endpoint and its restricted upload token', async () => {
  requests.mockResolvedValueOnce(json({ status: 'ok' }))
  await screenApi.heartbeat(7, 'recording-token')
  expect(requests.mock.calls[0][0]).toBe(screenApi.uploadUrl(7).replace('/upload', '/heartbeat'))
  expect(requests.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    headers: { Authorization: 'Bearer recording-token' },
  })
})

test('page-close abandonment keeps its restricted request alive after navigation', async () => {
  requests.mockResolvedValueOnce(json({ status: 'ok' }))
  await screenApi.abandon(7, 'recording-token')
  expect(requests.mock.calls[0][0]).toBe(screenApi.failedUrl(7))
  expect(requests.mock.calls[0][1]).toMatchObject({
    method: 'PATCH',
    keepalive: true,
    headers: { Authorization: 'Bearer recording-token', 'Content-Type': 'application/json' },
  })
  expect(JSON.parse(requests.mock.calls[0][1]!.body as string)).toEqual({
    error: 'Browser page closed before the capture was delivered.',
  })
})

test('proxy uploads retain clock, soundtrack health and the native container filename', async () => {
  requests
    .mockResolvedValueOnce(json({ mode: 'proxy' }))
    .mockResolvedValueOnce(json({ status: 'ok' }))
  await screenApi.deliver(
    7,
    'one-recording-token',
    new Blob(['mp4'], { type: 'video/mp4' }),
    metadata,
  )
  const form = requests.mock.calls[1][1]!.body as FormData
  expect(form.get('epoch_ms')).toBe('1700000000123')
  expect(form.get('audio_status')).toBe('failed')
  expect(form.get('audio_error')).toBe('Audio clock interrupted')
  expect((form.get('file') as File).name).toBe('screen.mp4')
  expect(requests.mock.calls[1][0]).toContain('/screen/recordings/7/upload')
})

test('direct bucket uploads send soundtrack metadata to completion and no application token to the bucket', async () => {
  requests
    .mockResolvedValueOnce(
      json({ mode: 'resumable', upload_url: 'https://bucket.test/signed-session' }),
    )
    .mockResolvedValueOnce(json({}))
    .mockResolvedValueOnce(json({ status: 'ok' }))
  await screenApi.deliver(
    7,
    'secret-upload-token',
    new Blob(['webm'], { type: 'video/webm' }),
    metadata,
  )
  expect(requests.mock.calls[1][1]!.headers).toEqual({ 'Content-Type': 'video/webm' })
  expect(JSON.parse(requests.mock.calls[2][1]!.body as string)).toEqual({
    ...metadata,
    content_type: 'video/webm',
  })
  expect(requests.mock.calls[2][0]).toContain('/screen/recordings/7/complete')
})

test('a refused media upload never reports completed audio', async () => {
  requests
    .mockResolvedValueOnce(json({ mode: 'resumable', upload_url: 'https://bucket.test/session' }))
    .mockResolvedValueOnce(json({}, 500))
  await expect(screenApi.deliver(7, 'token', new Blob(['frames']), metadata)).rejects.toThrow(
    'bucket said 500',
  )
  expect(requests).toHaveBeenCalledTimes(2)
})

test('a retried completion preserves the same captured media and audio health', async () => {
  vi.useFakeTimers()
  requests
    .mockResolvedValueOnce(json({ mode: 'resumable', upload_url: 'https://bucket.test/session' }))
    .mockResolvedValueOnce(json({}))
    .mockResolvedValueOnce(json({}, 503))
    .mockResolvedValueOnce(json({ status: 'ok' }))
  const delivered = screenApi.deliver(
    7,
    'token',
    new Blob(['frames'], { type: 'video/webm' }),
    metadata,
  )
  await vi.advanceTimersByTimeAsync(1001)
  await delivered
  expect(requests.mock.calls[2][1]!.body).toBe(requests.mock.calls[3][1]!.body)
  expect(requests.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
})
