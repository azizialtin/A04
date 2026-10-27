import { useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  adminApi,
  type ReplayRef,
  type ResearcherCreate,
  type SequenceItemInput,
  type Study,
  type VideoUploadInput,
} from '../api/admin'

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

export function useExports(studyId: number, participantIds?: string[]) {
  // Part of the key, so narrowing the selection fetches fresh counts rather
  // than showing the whole study's under a filtered heading.
  const scope = participantIds ? [...participantIds].sort().join(',') : 'all'
  return useQuery({
    queryKey: ['exports', studyId, scope],
    queryFn: () => adminApi.listExports(studyId, participantIds),
    // An empty selection has nothing to count; without this it would read as
    // "no filter" and fetch the whole study.
    enabled: participantIds === undefined || participantIds.length > 0,
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
  return useQuery({
    queryKey: ['participants', studyId],
    queryFn: () => adminApi.listParticipants(studyId),
  })
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
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['participants', studyId] })
      qc.invalidateQueries({ queryKey: ['participant', id] })
      // A hand-picked order leaves whichever set they had, so its count moves.
      qc.invalidateQueries({ queryKey: ['video-sets', studyId] })
    },
  })
}

export function useAssignVideoSet(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, videoSetId }: { id: string; videoSetId: number }) =>
      adminApi.assignVideoSet(id, videoSetId),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['participants', studyId] })
      qc.invalidateQueries({ queryKey: ['participant', id] })
      qc.invalidateQueries({ queryKey: ['video-sets', studyId] })
    },
  })
}

export function useVideoSets(studyId: number) {
  return useQuery({
    queryKey: ['video-sets', studyId],
    queryFn: () => adminApi.listVideoSets(studyId),
  })
}

export function useCreateVideoSet(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; items: SequenceItemInput[] }) =>
      adminApi.createVideoSet(studyId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['video-sets', studyId] }),
  })
}

export function useUpdateVideoSet(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; items?: SequenceItemInput[] }) =>
      adminApi.updateVideoSet(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['video-sets', studyId] })
      // A rename shows up against every participant who was dealt the set.
      qc.invalidateQueries({ queryKey: ['participants', studyId] })
    },
  })
}

export function useDeleteVideoSet(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => adminApi.deleteVideoSet(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['video-sets', studyId] })
      qc.invalidateQueries({ queryKey: ['participants', studyId] })
    },
  })
}

export function useQuestionnaires(studyId: number) {
  return useQuery({
    queryKey: ['questionnaires', studyId],
    queryFn: () => adminApi.listQuestionnaires(studyId),
  })
}

export function useCreateQuestionnaire(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Parameters<typeof adminApi.createQuestionnaire>[1]) =>
      adminApi.createQuestionnaire(studyId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questionnaires', studyId] }),
  })
}

export function useUpdateQuestionnaire(studyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: { id: number } & Parameters<typeof adminApi.updateQuestionnaire>[1]) =>
      adminApi.updateQuestionnaire(id, body),
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
    mutationFn: ({ id, force }: { id: number; force?: boolean }) =>
      adminApi.deleteQuestionnaire(id, force),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questionnaires', studyId] }),
  })
}

export function useGazeRecordings(studyId?: number) {
  return useQuery({
    queryKey: ['gaze', studyId ?? null],
    queryFn: () => adminApi.listGaze(studyId),
  })
}

export function useScreenRecordings(studyId?: number, offset = 0) {
  return useQuery({
    queryKey: ['screen-recordings', studyId ?? null, offset],
    queryFn: () => adminApi.listScreenRecordings(studyId, offset),
  })
}

export function useDownloadMedia() {
  return useMutation({
    mutationFn: ({ kind, id }: { kind: 'video' | 'screen'; id: number }) =>
      adminApi.downloadMedia(kind, id),
  })
}

export function useReplay(ref: ReplayRef | null) {
  return useQuery({
    queryKey: ['replay', ref?.kind, ref?.id],
    queryFn: () => adminApi.getReplay(ref as ReplayRef),
    enabled: ref != null,
  })
}

export function useOverviewStats(days = 30) {
  return useQuery({
    queryKey: ['stats', 'overview', days],
    queryFn: () => adminApi.overviewStats(days),
  })
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

export function useResearchers() {
  return useQuery({ queryKey: ['researchers'], queryFn: adminApi.listResearchers })
}

export function useCreateResearcher() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ResearcherCreate) => adminApi.createResearcher(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['researchers'] }),
  })
}

export function useResetResearcherPassword() {
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      adminApi.resetResearcherPassword(id, password),
  })
}

export function useRevokeResearcherSessions() {
  return useMutation({ mutationFn: (id: number) => adminApi.revokeResearcherSessions(id) })
}

export function useChangeMyPassword() {
  return useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) =>
      adminApi.changeMyPassword(current, next),
  })
}
