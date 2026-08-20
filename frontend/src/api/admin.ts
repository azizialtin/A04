import apiClient from './client'
import type { ReplayPoint } from './participant'

export interface Study {
  id: number
  name: string
  description: string
  sosci_pretest_url: string
  sosci_posttest_url: string
  sosci_id_param: string
  is_active: boolean
}

export interface AdminVideo {
  id: number
  study_id: number
  title: string
  phase_type: string
  task_description: string
  info_text: string
  student_task_text: string
  time_limit_seconds: number | null
  has_file: boolean
}

export interface AdminParticipant {
  id: string
  status: string
  slot_count: number
}

export interface SequenceSlot {
  slot_index: number
  video_id: number
  video_title: string
  phase_type: string
}

export interface ParticipantDetail {
  id: string
  status: string
  current_step_index: number | null
  sequence: SequenceSlot[]
}

export interface AdminQuestionnaire {
  id: number
  study_id: number
  placement: string
  title: string
  description: string
  order_index: number
  questions: unknown[]
}

export interface ScreenSummary {
  id: number
  status: 'recording' | 'stored' | 'failed'
  error: string | null
  duration_ms: number | null
  byte_size: number | null
}

export interface GazeRow {
  id: number
  participant_id: string
  video_id: number
  video_title: string
  sample_count: number
  sampling_rate_hz: number
  started_at: string
  completed_at: string | null
  screen: ScreenSummary | null
}

export interface AdminReplay {
  recording_id: number
  participant_id: string
  video_id: number
  video_title: string
  video_url: string
  // "screen" — the capture of the whole display. "clip" — the stimulus alone.
  source: 'screen' | 'clip'
  epoch_ms: number | null
  duration_ms: number | null
  sampling_rate_hz: number
  plotted_points: number
  invalid_samples: number
  unmapped_samples: number
  offscreen_samples: number
  has_geometry: boolean
  points: ReplayPoint[]
}

export interface AuditRow {
  id: number
  actor_email: string | null
  action: string
  created_at: string
  meta: Record<string, unknown>
}

export interface SequenceItemInput {
  video_id: number
  slot_index: number
  phase_type: string
}

export const EXPORT_KINDS = [
  'notes',
  'diagnoses',
  'responses',
  'events',
  'gaze',
  'calibration',
] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

export const adminApi = {
  listStudies: () => apiClient.get<Study[]>('/admin/studies').then((r) => r.data),
  createStudy: (body: Partial<Study>) => apiClient.post<Study>('/admin/studies', body).then((r) => r.data),
  getStudy: (id: number) => apiClient.get<Study>(`/admin/studies/${id}`).then((r) => r.data),
  updateStudy: (id: number, body: Partial<Study>) =>
    apiClient.patch<Study>(`/admin/studies/${id}`, body).then((r) => r.data),
  deleteStudy: (id: number, force = false) =>
    apiClient.delete(`/admin/studies/${id}?force=${force}`).then((r) => r.data),

  listVideos: (studyId: number) =>
    apiClient.get<AdminVideo[]>(`/admin/studies/${studyId}/videos`).then((r) => r.data),
  uploadVideo: (studyId: number, form: FormData, onProgress?: (percent: number) => void) =>
    apiClient
      .post<AdminVideo>(`/admin/studies/${studyId}/videos`, form, {
        // Case clips run to hundreds of megabytes; a button that just sits
        // there looks broken.
        timeout: 0,
        onUploadProgress: (e) =>
          onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
      })
      .then((r) => r.data),
  deleteVideo: (id: number) => apiClient.delete(`/admin/videos/${id}`).then((r) => r.data),

  listParticipants: (studyId: number) =>
    apiClient.get<AdminParticipant[]>(`/admin/studies/${studyId}/participants`).then((r) => r.data),
  createParticipants: (studyId: number, ids: string[]) =>
    apiClient
      .post<{ created: string[]; skipped: string[] }>(`/admin/studies/${studyId}/participants`, { ids })
      .then((r) => r.data),
  getParticipant: (id: string) =>
    apiClient.get<ParticipantDetail>(`/admin/participants/${id}`).then((r) => r.data),
  deleteParticipant: (id: string) => apiClient.delete(`/admin/participants/${id}`).then((r) => r.data),
  setSequence: (id: string, items: SequenceItemInput[]) =>
    apiClient.put(`/admin/participants/${id}/videos`, { items }).then((r) => r.data),
  bulkAssign: (studyId: number, participant_ids: string[], items: SequenceItemInput[]) =>
    apiClient
      .post<{ applied: string[]; skipped: string[] }>(`/admin/studies/${studyId}/bulk-assign`, {
        participant_ids,
        items,
      })
      .then((r) => r.data),

  listQuestionnaires: (studyId: number) =>
    apiClient.get<AdminQuestionnaire[]>(`/admin/studies/${studyId}/questionnaires`).then((r) => r.data),
  createQuestionnaire: (studyId: number, body: Partial<AdminQuestionnaire>) =>
    apiClient.post<AdminQuestionnaire>(`/admin/studies/${studyId}/questionnaires`, body).then((r) => r.data),
  seedQuestionnaires: (studyId: number) =>
    apiClient
      .post<AdminQuestionnaire[]>(`/admin/studies/${studyId}/questionnaires/seed`)
      .then((r) => r.data),
  updateQuestionnaire: (id: number, body: Partial<AdminQuestionnaire>) =>
    apiClient.patch<AdminQuestionnaire>(`/admin/questionnaires/${id}`, body).then((r) => r.data),
  deleteQuestionnaire: (id: number, force = false) =>
    apiClient.delete(`/admin/questionnaires/${id}?force=${force}`).then((r) => r.data),

  listGaze: (studyId?: number) =>
    apiClient
      .get<{ items: GazeRow[] }>('/admin/gaze/recordings', { params: studyId ? { study_id: studyId } : {} })
      .then((r) => r.data.items),
  getGazeReplay: (recordingId: number) =>
    apiClient.get<AdminReplay>(`/admin/gaze/recordings/${recordingId}/replay`).then((r) => r.data),
  listAudit: () => apiClient.get<{ items: AuditRow[] }>('/admin/audit').then((r) => r.data.items),

  downloadExport: async (studyId: number, kind: ExportKind) => {
    const res = await apiClient.get(`/admin/studies/${studyId}/export/${kind}`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${kind}.csv`
    a.click()
    URL.revokeObjectURL(url)
  },
}
