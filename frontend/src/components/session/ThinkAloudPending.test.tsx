import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { participantApi, type ReplayData } from '../../api/participant'
import { uploadSettled } from '../../lib/screenCapture'
import ThinkAloudScreen from './ThinkAloudScreen'

vi.mock('../../api/participant', () => ({
  participantApi: { getVideoReplay: vi.fn(), getVideoNotes: vi.fn() },
}))
vi.mock('../../lib/screenCapture', () => ({ uploadSettled: vi.fn() }))

const clip: ReplayData = {
  video_url: '/original.mp4',
  source: 'clip',
  recorder: null,
  sampling_rate_hz: 120,
  plotted_points: 0,
  invalid_samples: 0,
  unmapped_samples: 0,
  offscreen_samples: 0,
  has_geometry: false,
  points: [],
  epoch_ms: null,
  duration_ms: null,
  recording_pending: false,
}
const stored: ReplayData = {
  ...clip,
  video_url: '/recorded.mp4',
  source: 'screen',
  recorder: 'bridge',
  epoch_ms: 1700000000123,
  audio_status: 'captured',
  recording_pending: false,
}
const getReplay = vi.mocked(participantApi.getVideoReplay)
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  getReplay.mockReset()
  vi.mocked(participantApi.getVideoNotes).mockResolvedValue([])
  vi.mocked(uploadSettled).mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.useRealTimers()
})

async function mount() {
  const result = render(
    <QueryClientProvider client={client}>
      <ThinkAloudScreen videoId={7} onComplete={vi.fn()} />
    </QueryClientProvider>,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  return result
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

test('waits for a pending bridge upload instead of sticking to the original-video fallback', async () => {
  getReplay.mockResolvedValueOnce({ ...clip, recording_pending: true }).mockResolvedValue(stored)
  const { container } = await mount()
  expect(container.querySelector('video')).toBeNull()
  expect(screen.queryByRole('heading')).toBeNull()
  await advance(1100)
  expect(container.querySelector('video')?.getAttribute('src')).toContain('/recorded.mp4')
  expect(getReplay).toHaveBeenCalledTimes(2)
  await advance(2000)
  expect(getReplay).toHaveBeenCalledTimes(2)
})

test('a newer pending capture delays replay of an older stored one', async () => {
  getReplay
    .mockResolvedValueOnce({ ...stored, video_url: '/older.mp4', recording_pending: true })
    .mockResolvedValue(stored)
  const { container } = await mount()
  expect(container.querySelector('video')).toBeNull()
  await advance(1100)
  expect(container.querySelector('video')?.getAttribute('src')).toContain('/recorded.mp4')
})

test('historical clip fallback with no pending upload does not incur a delay or polling', async () => {
  getReplay.mockResolvedValue(clip)
  const { container } = await mount()
  expect(container.querySelector('video')?.getAttribute('src')).toContain('/original.mp4')
  await advance(3000)
  expect(getReplay).toHaveBeenCalledTimes(1)
})

test('a failed pending upload returns to the available fallback', async () => {
  getReplay.mockResolvedValueOnce({ ...clip, recording_pending: true }).mockResolvedValue(clip)
  const { container } = await mount()
  await advance(1100)
  expect(container.querySelector('video')?.getAttribute('src')).toContain('/original.mp4')
})

test('browser delivery and bridge polling share the same total sixty-second wait budget', async () => {
  let finishBrowser!: () => void
  vi.mocked(uploadSettled).mockReturnValue(
    new Promise<void>((resolve) => {
      finishBrowser = resolve
    }),
  )
  getReplay.mockResolvedValue({ ...clip, recording_pending: true })
  const { container } = await mount()
  await advance(50_000)
  expect(getReplay).not.toHaveBeenCalled()
  finishBrowser()
  await advance(10)
  expect(container.querySelector('video')).toBeNull()
  await advance(10_000)
  expect(container.querySelector('video')?.getAttribute('src')).toContain('/original.mp4')
  const calls = getReplay.mock.calls.length
  await advance(3000)
  expect(getReplay).toHaveBeenCalledTimes(calls)
})

test('a poll resolving after the wait cap cannot replace the already exposed fallback', async () => {
  let finishPoll!: (value: ReplayData) => void
  getReplay.mockResolvedValueOnce({ ...clip, recording_pending: true }).mockReturnValueOnce(
    new Promise<ReplayData>((resolve) => {
      finishPoll = resolve
    }),
  )
  const { container } = await mount()
  await advance(1100)
  await advance(60_000)
  const video = container.querySelector('video')!
  expect(video.getAttribute('src')).toContain('/original.mp4')
  video.currentTime = 12
  finishPoll(stored)
  await advance(20)
  expect(container.querySelector('video')).toBe(video)
  expect(video.getAttribute('src')).toContain('/original.mp4')
  expect(video.currentTime).toBe(12)
})

test('window focus cannot refetch and replace a selected replay', async () => {
  getReplay.mockResolvedValue(clip)
  const { container } = await mount()
  const video = container.querySelector('video')!
  getReplay.mockResolvedValue(stored)
  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  await advance(100)
  expect(getReplay).toHaveBeenCalledTimes(1)
  expect(container.querySelector('video')).toBe(video)
  expect(video.getAttribute('src')).toContain('/original.mp4')
})

test('a failed pending poll still exposes available fallback when the wait budget ends', async () => {
  getReplay
    .mockResolvedValueOnce({ ...clip, recording_pending: true })
    .mockRejectedValue(new Error('Temporary connection failure'))
  const { container } = await mount()
  await advance(60_100)
  expect(container.querySelector('video')?.getAttribute('src')).toContain('/original.mp4')
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeInTheDocument()
})

test('a failed browser delivery does not leave replay permanently waiting', async () => {
  vi.mocked(uploadSettled).mockRejectedValue(new Error('Browser upload failed'))
  getReplay.mockResolvedValue(clip)
  const { container } = await mount()
  expect(container.querySelector('video')?.getAttribute('src')).toContain('/original.mp4')
})

test('the next case waits independently even if its replay is already cached', async () => {
  getReplay.mockResolvedValue(stored)
  const result = await mount()
  expect(result.container.querySelector('video')?.getAttribute('src')).toContain('/recorded.mp4')
  let finishBrowser!: () => void
  vi.mocked(uploadSettled).mockReturnValue(
    new Promise<void>((resolve) => {
      finishBrowser = resolve
    }),
  )
  const next = { ...clip, video_url: '/next-case.mp4' }
  client.setQueryData(['replay', 8], next)
  getReplay.mockResolvedValue(next)
  result.rerender(
    <QueryClientProvider client={client}>
      <ThinkAloudScreen videoId={8} onComplete={vi.fn()} />
    </QueryClientProvider>,
  )
  await advance(20)
  expect(result.container.querySelector('video')).toBeNull()
  finishBrowser()
  await advance(20)
  await advance(20)
  expect(result.container.querySelector('video')?.getAttribute('src')).toContain('/next-case.mp4')
})

test('returning through a still-loading case selects a fresh replay instead of reusing the old selection', async () => {
  getReplay.mockResolvedValue(stored)
  const result = await mount()
  expect(result.container.querySelector('video')?.getAttribute('src')).toContain('/recorded.mp4')
  vi.mocked(uploadSettled).mockReturnValueOnce(new Promise<void>(() => {}))
  result.rerender(
    <QueryClientProvider client={client}>
      <ThinkAloudScreen videoId={8} onComplete={vi.fn()} />
    </QueryClientProvider>,
  )
  await advance(20)
  expect(result.container.querySelector('video')).toBeNull()

  let refreshed!: (value: ReplayData) => void
  getReplay.mockReturnValueOnce(
    new Promise<ReplayData>((resolve) => {
      refreshed = resolve
    }),
  )
  result.rerender(
    <QueryClientProvider client={client}>
      <ThinkAloudScreen videoId={7} onComplete={vi.fn()} />
    </QueryClientProvider>,
  )
  await advance(20)
  expect(result.container.querySelector('video')).toBeNull()
  refreshed({ ...stored, video_url: '/newer-recording.mp4' })
  await advance(20)
  expect(result.container.querySelector('video')?.getAttribute('src')).toContain(
    '/newer-recording.mp4',
  )
})
