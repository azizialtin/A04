import apiClient from './client'
import type { Question } from '../lib/questionnaire'

export interface Me {
  id: string
  study_name: string
  status: string
}

export interface NoteSnapshot {
  video_time_seconds: number
  // Browser wall clock. The playhead places a note in the clip; only this can
  // place it in a screen recording, which runs on wall time.
  client_ts: number | null
  text: string
  created_at: string
}

export interface ReplayPoint {
  t: number
  x: number
  y: number
}

export interface ReplayData {
  video_url: string
  // "screen" — the capture of the whole display, cursor and all. "clip" — the
  // stimulus on its own, for a case whose capture failed or predates it.
  source: 'screen' | 'clip'
  sampling_rate_hz: number
  plotted_points: number
  invalid_samples: number
  unmapped_samples: number
  offscreen_samples: number
  has_geometry: boolean
  points: ReplayPoint[]
  // Wall-clock ms at position 0 of a screen recording, so anything else on that
  // clock — the notes — lands on the same timeline. Null for a clip replay.
  epoch_ms: number | null
  duration_ms: number | null
}

interface StepBase {
  index: number
  completed: boolean
}

export type SessionStep =
  | (StepBase & { kind: 'welcome' })
  | (StepBase & {
      kind: 'sosci'
      variant: 'pretest' | 'posttest'
      url: string
      id_param: string
      participant_id: string
    })
  | (StepBase & { kind: 'calibration' })
  | (StepBase & { kind: 'phase_transition'; phase_type: string; phase_number: number })
  | (StepBase & { kind: 'case_intro'; phase_type: string; video_id: number })
  | (StepBase & {
      // The pre-test block: one page per battery, answered once for the run.
      kind: 'questionnaire'
      questionnaire_id: number
      placement: string
      title: string
      description: string
      questions: Question[]
      video_id: null
      page: number
      page_count: number
    })
  | (StepBase & {
      kind: 'case_video'
      video_id: number
      title: string
      task_description: string
      info_text: string
      student_task_text: string
      time_limit_seconds: number | null
    })
  | (StepBase & {
      kind: 'diagnosis'
      video_id: number
      title: string
      task_description: string
      // Rating questions shown under the write-up and submitted with it.
      questions: Question[]
    })
  | (StepBase & {
      kind: 'case_outro'
      video_id: number
      phase_type: string
      questionnaire_id: number | null
      instruction: string
      questions: Question[]
    })
  | (StepBase & { kind: 'think_aloud'; video_id: number })
  | (StepBase & { kind: 'thanks' })

export interface SessionScript {
  status: string
  current_step_index: number
  total_steps: number
  steps: SessionStep[]
}

export interface ProgressResult {
  status: string
  current_step_index: number
  total_steps: number
  complete: boolean
}

export const authApi = {
  participantLogin: (participantId: string) =>
    apiClient
      .post<{ access_token: string }>('/auth/participant/login', { participant_id: participantId })
      .then((r) => r.data),
  adminLogin: (email: string, password: string) =>
    apiClient
      .post<{ access_token: string }>('/auth/admin/login', { email, password })
      .then((r) => r.data),
}

export const participantApi = {
  getMe: () => apiClient.get<Me>('/participant/me').then((r) => r.data),
  getSession: () => apiClient.get<SessionScript>('/participant/session').then((r) => r.data),
  updateProgress: (currentStepIndex: number) =>
    apiClient
      .patch<ProgressResult>('/participant/session/progress', { current_step_index: currentStepIndex })
      .then((r) => r.data),
  getVideoUrl: (videoId: number) =>
    apiClient.get<{ signed_url: string }>(`/participant/videos/${videoId}/url`).then((r) => r.data),
  getVideoNotes: (videoId: number) =>
    apiClient.get<NoteSnapshot[]>(`/participant/videos/${videoId}/notes`).then((r) => r.data),
  getVideoReplay: (videoId: number) =>
    apiClient.get<ReplayData>(`/gaze/videos/${videoId}/replay`).then((r) => r.data),
  createNote: (body: {
    video_id: number
    video_time_seconds: number
    client_ts?: number
    text: string
  }) =>
    apiClient.post<{ id: number }>('/participant/notes', body).then((r) => r.data),
  createDiagnosis: (body: {
    video_id: number
    text: string
    time_spent_seconds?: number
    answers?: Record<string, unknown>
  }) => apiClient.post<{ id: number }>('/participant/diagnosis', body).then((r) => r.data),
  respondQuestionnaire: (
    questionnaireId: number,
    body: {
      // Null for a pre-test page, which belongs to the run rather than a case.
      video_id: number | null
      answers: Record<string, unknown>
      time_spent_seconds?: number
    },
  ) => apiClient.post(`/participant/questionnaires/${questionnaireId}/respond`, body).then((r) => r.data),
  logEvent: (body: {
    event_type: string
    video_id?: number
    payload?: Record<string, unknown>
    client_ts?: number
  }) => apiClient.post('/participant/events', body).then((r) => r.data),
}
