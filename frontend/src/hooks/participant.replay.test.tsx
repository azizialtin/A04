import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { participantApi, type ReplayData } from '../api/participant'
import { useVideoReplay } from './participant'

const clip: ReplayData = {
  video_url: '/clip.mp4',
  source: 'clip',
  recording_pending: true,
  sampling_rate_hz: 0,
  plotted_points: 0,
  invalid_samples: 0,
  unmapped_samples: 0,
  offscreen_samples: 0,
  has_geometry: false,
  points: [],
  epoch_ms: null,
  duration_ms: null,
  recorder: null,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('a delayed bridge upload replaces the fallback without a page reload, then stops polling', async () => {
  vi.useFakeTimers()
  const ready: ReplayData = {
    ...clip,
    source: 'screen',
    recording_pending: false,
    video_url: '/screen.mp4',
    recorder: 'bridge',
  }
  const get = vi
    .spyOn(participantApi, 'getVideoReplay')
    .mockResolvedValueOnce(clip)
    .mockResolvedValue(ready)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result, unmount } = renderHook(() => useVideoReplay(42), { wrapper })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  expect(result.current.data?.source).toBe('clip')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600)
  })
  expect(result.current.data?.video_url).toBe('/screen.mp4')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(get).toHaveBeenCalledTimes(2)
  unmount()
  client.clear()
})

test('a failed or absent capture does not continuously poll the fallback', async () => {
  vi.useFakeTimers()
  const get = vi
    .spyOn(participantApi, 'getVideoReplay')
    .mockResolvedValue({ ...clip, recording_pending: false })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { unmount } = renderHook(() => useVideoReplay(42), { wrapper })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(get).toHaveBeenCalledTimes(1)
  unmount()
  client.clear()
})
