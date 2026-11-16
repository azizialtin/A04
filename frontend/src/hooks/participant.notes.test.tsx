import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { participantApi } from '../api/participant'
import { __reset, enqueue, start, stop } from '../lib/outbox'
import { useVideoNotes } from './participant'

afterEach(() => {
  __reset()
  vi.restoreAllMocks()
})

test('case and diagnosis read queued edits, including empty text, while the notes fetch fails', async () => {
  vi.spyOn(participantApi, 'getVideoNotes').mockRejectedValue(new Error('offline'))
  vi.spyOn(participantApi, 'createNote').mockRejectedValue(new Error('offline'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(
    ['notes', 7],
    [{ text: 'Older server note', video_time_seconds: 0, client_ts: 1, created_at: '' }],
  )
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  start('OTHER')
  enqueue('note', { video_id: 7, text: 'Other participant' })
  start('T-001')
  enqueue('note', { video_id: 8, text: 'Other case' })
  enqueue('note', { video_id: 7, text: 'Latest local edit', client_ts: 2, video_time_seconds: 12 })
  const { result, unmount } = renderHook(() => useVideoNotes(7), { wrapper })
  expect(result.current.data?.slice(-1)[0]?.text).toBe('Latest local edit')
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.data?.slice(-1)[0]?.text).toBe('Latest local edit')
  act(() => enqueue('note', { video_id: 7, text: '', client_ts: 3, video_time_seconds: 13 }))
  expect(result.current.data?.slice(-1)[0]?.text).toBe('')
  expect(result.current.isLoading).toBe(false)
  stop()
  unmount()
  client.clear()
})
