import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { participantApi } from '../api/participant'

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: participantApi.getMe })
}

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: participantApi.getSession })
}

export function useVideoNotes(videoId: number) {
  return useQuery({
    queryKey: ['notes', videoId],
    queryFn: () => participantApi.getVideoNotes(videoId),
  })
}

export function useVideoReplay(videoId: number, enabled = true) {
  return useQuery({
    queryKey: ['replay', videoId],
    queryFn: () => participantApi.getVideoReplay(videoId),
    enabled,
  })
}

export function useUpdateProgress() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (value: number | { index: number; expected: number }) =>
      typeof value === 'number'
        ? participantApi.updateProgress(value)
        : participantApi.updateProgress(value.index, value.expected),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  })
}

export function useStepBack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body?: { visit_id?: string; client_ts?: number }) => participantApi.stepBack(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  })
}

// Both writes below are idempotent server-side — one response and one
// diagnosis per case — so a retry cannot duplicate a row, and a blip during
// submit does not put the participant's answer at risk.
const RETRY = { retry: 2, retryDelay: (attempt: number) => 500 * 2 ** attempt }

export function useRespondQuestionnaire() {
  const qc = useQueryClient()
  return useMutation({
    ...RETRY,
    mutationFn: (v: {
      questionnaireId: number
      video_id: number | null
      answers: Record<string, unknown>
      time_spent_seconds?: number
      visit_id?: string
      client_ts?: number
      advance?: boolean
    }) =>
      participantApi.respondQuestionnaire(v.questionnaireId, {
        video_id: v.video_id,
        answers: v.answers,
        time_spent_seconds: v.time_spent_seconds,
        visit_id: v.visit_id,
        client_ts: v.client_ts,
        advance: v.advance,
      }),
    onSuccess: (_data, variables) =>
      variables.advance ? qc.invalidateQueries({ queryKey: ['session'] }) : undefined,
    onError: async (_error, variables) => {
      if (!variables.advance) return
      // The save may have committed while every acknowledgement was lost.
      // Reconcile the pointer without replacing a readable draft with a query error.
      try {
        qc.setQueryData(['session'], await participantApi.getSession())
      } catch {
        /* retain the current page and its local draft until connected */
      }
    },
  })
}

export function useEnterQuestionnaire() {
  return useMutation({ ...RETRY, mutationFn: participantApi.enterQuestionnaire })
}

export function useFinishCK() {
  const qc = useQueryClient()
  return useMutation({
    ...RETRY,
    mutationFn: participantApi.finishCK,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  })
}

// Notes and playback events are not here on purpose: they go through the
// outbox (lib/outbox.ts), which retries and survives a reload. Two routes to
// the same write would mean one of them quietly losing data.

export function useCreateDiagnosis() {
  return useMutation({ ...RETRY, mutationFn: participantApi.createDiagnosis })
}
