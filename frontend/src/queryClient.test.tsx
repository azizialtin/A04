import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { participantApi, type SessionScript } from './api/participant'
import { useSession, useUpdateProgress } from './hooks/participant'
import { queryClient } from './queryClient'

const script: SessionScript = {
  status: 'active',
  current_step_index: 37,
  total_steps: 69,
  steps: [],
}
const clients: QueryClient[] = []

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

function setup(cached = true) {
  const client = new QueryClient({ defaultOptions: queryClient.getDefaultOptions() })
  clients.push(client)
  if (cached) client.setQueryData(['session'], script)
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => ({ session: useSession(), update: useUpdateProgress() }), { wrapper })
}

test('a browser offline hint cannot strand a reachable lab API before the progress request', async () => {
  const next = { ...script, current_step_index: 38 }
  vi.spyOn(participantApi, 'getSession').mockResolvedValue(next)
  const update = vi.spyOn(participantApi, 'updateProgress').mockResolvedValue({
    status: 'active',
    current_step_index: 38,
    total_steps: 69,
    complete: false,
  })
  const { result } = setup()
  onlineManager.setOnline(false)
  act(() => result.current.update.mutate({ index: 38, expected: 37 }))

  await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith(38, 37))
  await waitFor(() => expect(result.current.update.isSuccess).toBe(true))
  expect(result.current.update.isPaused).toBe(false)
  expect(result.current.session.data?.current_step_index).toBe(38)
  expect(onlineManager.isOnline()).toBe(false)
})

test('a session can load from the lab API while the browser reports offline', async () => {
  const getSession = vi.spyOn(participantApi, 'getSession').mockResolvedValue(script)
  onlineManager.setOnline(false)
  const { result } = setup(false)
  await waitFor(() => expect(result.current.session.isSuccess).toBe(true))
  expect(getSession).toHaveBeenCalledOnce()
  expect(result.current.session.data?.current_step_index).toBe(37)
})

test('an actual transport failure settles and leaves the current step available for retry', async () => {
  const update = vi.spyOn(participantApi, 'updateProgress').mockRejectedValue(new Error('offline'))
  const { result } = setup()
  onlineManager.setOnline(false)
  act(() => result.current.update.mutate({ index: 38, expected: 37 }))
  await waitFor(() => expect(result.current.update.isError).toBe(true))
  expect(update).toHaveBeenCalledOnce()
  expect(result.current.update.isPaused).toBe(false)
  expect(result.current.session.data?.current_step_index).toBe(37)
})
