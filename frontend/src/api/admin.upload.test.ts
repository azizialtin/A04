import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi } from './admin'
import apiClient from './client'

vi.mock('./client', () => ({
  default: { post: vi.fn() },
}))

const post = vi.mocked(apiClient.post)

/** A stand-in for the browser's uploader that records what it was handed. */
class FakeXHR {
  static last: FakeXHR | null = null
  static status = 200

  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  status = 200
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXHR.last = this
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  send(body: unknown) {
    this.body = body
    this.status = FakeXHR.status
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent)
    queueMicrotask(() => this.onload?.())
  }
}

const clip = () => new File([new Uint8Array(64)], 'case one.mp4', { type: 'video/mp4' })

const meta = {
  title: 'Case one',
  phase_type: 'training',
  task_description: '',
  info_text: '',
  student_task_text: '',
  time_limit_seconds: null,
}

beforeEach(() => {
  post.mockReset()
  FakeXHR.last = null
  FakeXHR.status = 200
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
})

test('sends the clip to the bucket and only its details to the backend', async () => {
  post
    .mockResolvedValueOnce({
      data: { mode: 'resumable', object_name: 'abc.mp4', upload_url: 'https://bucket/session' },
    } as never)
    .mockResolvedValueOnce({ data: { id: 9, title: 'Case one' } } as never)

  const progress: number[] = []
  const video = await adminApi.uploadVideo(3, { ...meta, file: clip() }, (p) => progress.push(p))

  expect(video).toEqual({ id: 9, title: 'Case one' })
  expect(FakeXHR.last?.method).toBe('PUT')
  expect(FakeXHR.last?.url).toBe('https://bucket/session')
  expect(progress).toContain(50)

  // The admin's token is ours, not the bucket's; sending it there would hand a
  // third party a working credential.
  expect(FakeXHR.last?.headers.Authorization).toBeUndefined()

  // The backend is told the name it minted, never one the browser made up.
  const [path, body] = post.mock.calls[1]
  expect(path).toBe('/admin/studies/3/videos/finalize')
  expect(body).toMatchObject({ object_name: 'abc.mp4', title: 'Case one' })

  // The bytes themselves never went through the app.
  expect(post.mock.calls.some(([p]) => p === '/admin/studies/3/videos')).toBe(false)
})

test('falls back to posting the file when there is no bucket', async () => {
  post
    .mockResolvedValueOnce({
      data: { mode: 'proxy', object_name: 'abc.mp4', upload_url: null },
    } as never)
    .mockResolvedValueOnce({ data: { id: 4 } } as never)

  await adminApi.uploadVideo(3, { ...meta, file: clip() })

  expect(FakeXHR.last).toBeNull()
  const [path, body] = post.mock.calls[1]
  expect(path).toBe('/admin/studies/3/videos')
  expect(body).toBeInstanceOf(FormData)
  expect((body as FormData).get('title')).toBe('Case one')
})

test('a bucket that refuses the upload does not create a video row', async () => {
  FakeXHR.status = 403
  post.mockResolvedValueOnce({
    data: { mode: 'resumable', object_name: 'abc.mp4', upload_url: 'https://bucket/session' },
  } as never)

  await expect(adminApi.uploadVideo(3, { ...meta, file: clip() })).rejects.toThrow('403')
  // Only the request that opened the upload; finalize was never reached.
  expect(post).toHaveBeenCalledTimes(1)
})
