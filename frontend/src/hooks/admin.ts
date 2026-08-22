import { useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { adminApi, type SequenceItemInput, type Study, type VideoUploadInput } from '../api/admin'

export function useStudies() {
  return useQuery({ queryKey: ['studies'], queryFn: adminApi.listStudies })
}

export function useStudy(id: number) {
  return useQuery({ queryKey: ['study', id], queryFn: () => adminApi.getStudy(id) })
}

export function useCreateStudy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<Study>) => adminApi.createStudy(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['studies'] }),
  })
}

export function useUpdateStudy(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<Study>) => adminApi.updateStudy(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['study', id] })
      qc.invalidateQueries({ queryKey: ['studies'] })
    },
  })
}

export function useDeleteStudy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, force }: { id: number; force?: boolean }) => adminApi.deleteStudy(id, force),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['studies'] }),
  })
}

export function useVideos(studyId: number) {
  return useQuery({ queryKey: ['videos', studyId], queryFn: () => adminApi.listVideos(studyId) })
}

export function useUploadVideo(studyId: number) {
  const qc = useQueryClient()
  const [progress, setProgress] = useState<number | null>(null)

  const mutation = useMutation({
    mutationFn: (input: VideoUploadInput) => {
      setProgress(0)
      return adminApi.uploadVideo(studyId, input, setProgress)
    },
    onSettled: () => setProgress(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['videos', studyId] }),
  })

  return { ...mutation, progress }
}

export function useDeleteVideo(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => adminApi.deleteVideo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['videos', studyId] }),
  })
}

export function useParticipants(studyId: number) {
  return useQuery({ queryKey: ['participants', studyId], queryFn: () => adminApi.listParticipants(studyId) })
}

export function useCreateParticipants(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => adminApi.createParticipants(studyId, ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['participants', studyId] }),
  })
}

export function useSetSequence(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, items }: { id: string; items: SequenceItemInput[] }) =>
      adminApi.setSequence(id, items),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['participants', studyId] }),
  })
}

export function useQuestionnaires(studyId: number) {
  return useQuery({ queryKey: ['questionnaires', studyId], queryFn: () => adminApi.listQuestionnaires(studyId) })
}

export function useCreateQuestionnaire(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Parameters<typeof adminApi.createQuestionnaire>[1]) =>
      adminApi.createQuestionnaire(studyId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questionnaires', studyId] }),
  })
}

export function useSeedQuestionnaires(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => adminApi.seedQuestionnaires(studyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questionnaires', studyId] }),
  })
}

export function useDeleteQuestionnaire(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, force }: { id: number; force?: boolean }) => adminApi.deleteQuestionnaire(id, force),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questionnaires', studyId] }),
  })
}

export function useGazeRecordings(studyId?: number) {
  return useQuery({ queryKey: ['gaze', studyId ?? null], queryFn: () => adminApi.listGaze(studyId) })
}

export function useGazeReplay(recordingId: number | null) {
  return useQuery({
    queryKey: ['gaze-replay', recordingId],
    queryFn: () => adminApi.getGazeReplay(recordingId as number),
    enabled: recordingId != null,
  })
}

export function useOverviewStats(days = 30) {
  return useQuery({ queryKey: ['stats', 'overview', days], queryFn: () => adminApi.overviewStats(days) })
}

export function useStudyStats(studyId: number, days = 30) {
  return useQuery({
    queryKey: ['stats', 'study', studyId, days],
    queryFn: () => adminApi.studyStats(studyId, days),
  })
}

export function useParticipantStats(id: string | null) {
  return useQuery({
    queryKey: ['stats', 'participant', id],
    queryFn: () => adminApi.participantStats(id as string),
    enabled: id != null,
  })
}

export function useAudit() {
  return useQuery({ queryKey: ['audit'], queryFn: adminApi.listAudit })
}
