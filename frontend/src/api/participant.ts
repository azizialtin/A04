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
  // Who made the screen recording: the bridge, or the page itself as fallback.
  recorder: 'bridge' | 'browser' | null
}

interface StepBase {
  index: number
  completed: boolean
}

/** The welcome page's wording as the study has it; empty strings mean the app's default. */
export interface WelcomeTexts {
  welcome_title: string
  welcome_intro: string
  welcome_steps: string[]
  welcome_note: string
}

export type SessionStep =
  | (StepBase & { kind: 'welcome'; texts?: WelcomeTexts })
  | (StepBase & {
      kind: 'sosci'
      variant: 'pretest' | 'posttest'
      url: string
      id_param: string
      participant_id: string
    })
  | (StepBase & { kind: 'calibration' })
  | (StepBase & { kind: 'phase_transition'; phase_type: string; phase_number: number })
  | (StepBase & {
      kind: 'case_intro'
      phase_type: string
      video_id: number
      // The study's own wording, or empty for the app's default.
      title: string
      body: string
    })
  | (StepBase & {
      // The pre-test block: one page per battery, answered once for the run.
      kind: 'questionnaire'
      questionnaire_id: number
      placement: string
      title: string
      description: string
      // The instrument the page belongs to; logged with the page's events.
      section: string
      questions: Question[]
      video_id: null
      page: number
      page_count: number
      // What is stored already, when the run was stepped back onto this page.
      previous_answers?: Record<string, unknown> | null
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
      section: string
      // Rating questions shown under the write-up and submitted with it.
      questions: Question[]
      previous_text?: string | null
      previous_answers?: Record<string, unknown> | null
    })
  | (StepBase & {
      kind: 'case_outro'
      video_id: number
      phase_type: string
      questionnaire_id: number | null
      // The battery's name. Not rendered — the screen leads with the
      // instruction — but it is what the interaction log calls this step.
      title: string
      section: string
      instruction: string
      questions: Question[]
      previous_answers?: Record<string, unknown> | null
      // The study's own heading and text; empty means the app's default.
      heading?: string
      body?: string
    })
  | (StepBase & {
      kind: 'think_aloud'
      video_id: number
      title: string
      // Where this case sits in its phase, and which of the block's recordings
      // this is. A block is one screen unless the study batches the training
      // phase, so `batch_size` is 1 for most runs.
      phase_type: string
      case_number: number
      case_total: number
      batch_position: number
      batch_size: number
      heading?: string
      body?: string
    })
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
      .patch<ProgressResult>('/participant/session/progress', {
        current_step_index: currentStepIndex,
      })
      .then((r) => r.data),
  /** The supervisor's one screen back; the server logs it. */
  stepBack: () =>
    apiClient.post<ProgressResult>('/participant/session/step-back').then((r) => r.data),
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
  }) => apiClient.post<{ id: number }>('/participant/notes', body).then((r) => r.data),
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
  ) =>
    apiClient
      .post(`/participant/questionnaires/${questionnaireId}/respond`, body)
      .then((r) => r.data),
  logEvent: (body: {
    event_type: string
    video_id?: number
    payload?: Record<string, unknown>
    client_ts?: number
  }) => apiClient.post('/participant/events', body).then((r) => r.data),
}
