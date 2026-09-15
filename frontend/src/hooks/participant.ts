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
    mutationFn: (index: number) => participantApi.updateProgress(index),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  })
}

// Both writes below are idempotent server-side — one response and one
// diagnosis per case — so a retry cannot duplicate a row, and a blip during
// submit does not put the participant's answer at risk.
const RETRY = { retry: 2, retryDelay: (attempt: number) => 500 * 2 ** attempt }

export function useRespondQuestionnaire() {
  return useMutation({
    ...RETRY,
    mutationFn: (v: {
      questionnaireId: number
      video_id: number | null
      answers: Record<string, unknown>
      time_spent_seconds?: number
    }) =>
      participantApi.respondQuestionnaire(v.questionnaireId, {
        video_id: v.video_id,
        answers: v.answers,
        time_spent_seconds: v.time_spent_seconds,
      }),
  })
}

// Notes and playback events are not here on purpose: they go through the
// outbox (lib/outbox.ts), which retries and survives a reload. Two routes to
// the same write would mean one of them quietly losing data.

export function useCreateDiagnosis() {
  return useMutation({ ...RETRY, mutationFn: participantApi.createDiagnosis })
}
