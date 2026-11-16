import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { participantApi, type SessionScript } from '../api/participant'
import { useSession, useUpdateProgress } from './participant'

const script: SessionScript = {
  status: 'active',
  current_step_index: 0,
  total_steps: 2,
  steps: [
    {
      index: 0,
      completed: false,
      kind: 'case_video',
      video_id: 7,
      title: 'Fall',
      task_description: '',
      info_text: '',
      student_task_text: '',
      time_limit_seconds: null,
    },
    {
      index: 1,
      completed: false,
      kind: 'diagnosis',
      video_id: 7,
      title: 'Diagnose',
      task_description: '',
      section: '',
      questions: [],
    },
  ],
}
const progress = { status: 'active', current_step_index: 1, total_steps: 2, complete: false }
const request = { index: 1, expected: 0 }

afterEach(() => vi.restoreAllMocks())

function setup(cached: SessionScript | undefined = script) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (cached) client.setQueryData(['session'], cached)
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => ({ session: useSession(), update: useUpdateProgress() }), {
    wrapper,
  })
  return { client, ...hook }
}

test('acknowledged navigation advances the cached screen before refetch, even if refetch fails', async () => {
  vi.spyOn(participantApi, 'updateProgress').mockResolvedValue(progress)
  let failRefetch!: (error: Error) => void
  const getSession = vi.spyOn(participantApi, 'getSession').mockImplementation(
    () =>
      new Promise<SessionScript>((_resolve, reject) => {
        failRefetch = reject
      }),
  )
  const { client, result, unmount } = setup()
  let mutation!: Promise<unknown>
  await act(async () => {
    mutation = result.current.update.mutateAsync(request)
  })
  expect(getSession).toHaveBeenCalledOnce()
  expect(client.getQueryData<SessionScript>(['session'])?.current_step_index).toBe(1)
  await act(async () => {
    failRefetch(new Error('offline after committed progress'))
    await mutation
  })
  await waitFor(() => expect(result.current.session.isError).toBe(true))
  expect(result.current.session.data?.current_step_index).toBe(1)
  expect(result.current.session.data?.steps[1].kind).toBe('diagnosis')
  expect(result.current.update.isSuccess).toBe(true)
  unmount()
  client.clear()
})

test('a lost progress acknowledgement preserves the old screen and permits the same guarded retry', async () => {
  const update = vi
    .spyOn(participantApi, 'updateProgress')
    .mockRejectedValueOnce(new Error('lost acknowledgement'))
    .mockResolvedValue(progress)
  const getSession = vi
    .spyOn(participantApi, 'getSession')
    .mockResolvedValue({ ...script, current_step_index: 1 })
  const { client, result, unmount } = setup()
  await act(async () => {
    await expect(result.current.update.mutateAsync(request)).rejects.toThrow('lost acknowledgement')
  })
  expect(client.getQueryData<SessionScript>(['session'])?.current_step_index).toBe(0)
  expect(getSession).not.toHaveBeenCalled()
  await act(async () => {
    await result.current.update.mutateAsync(request)
  })
  expect(update).toHaveBeenNthCalledWith(1, 1, 0)
  expect(update).toHaveBeenNthCalledWith(2, 1, 0)
  expect(client.getQueryData<SessionScript>(['session'])?.current_step_index).toBe(1)
  unmount()
  client.clear()
})

test('a delayed progress response cannot rewind a more recent cached pointer', async () => {
  vi.spyOn(participantApi, 'updateProgress').mockResolvedValue(progress)
  vi.spyOn(participantApi, 'getSession').mockRejectedValue(new Error('offline'))
  const { client, result, unmount } = setup({
    ...script,
    current_step_index: 2,
    status: 'completed',
  })
  await act(async () => {
    await result.current.update.mutateAsync(request)
  })
  expect(client.getQueryData<SessionScript>(['session'])?.current_step_index).toBe(2)
  expect(client.getQueryData<SessionScript>(['session'])?.status).toBe('completed')
  unmount()
  client.clear()
})
