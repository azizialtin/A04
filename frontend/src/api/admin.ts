import apiClient from './client'
import type { ReplayPoint } from './participant'

/** Participant-facing wording the researcher may change; empty means the app's default. */
export interface StudyTexts {
  welcome_title: string
  welcome_intro: string
  welcome_steps: string[]
  welcome_note: string
  case_intro_title: string
  case_intro_body: string
}

/** What a new video starts from; the texts can be followed rather than copied. */
export interface StudyVideoDefaults {
  time_limit_seconds: number | null
  task_description: string
  info_text: string
}

export interface Study {
  id: number
  name: string
  description: string
  sosci_pretest_url: string
  sosci_posttest_url: string
  sosci_id_param: string
  is_active: boolean
  texts: StudyTexts
  video_defaults: StudyVideoDefaults
  /** Training cases worked through before their think-aloud screens play. */
  think_aloud_batch_size: number
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
  /** True: participants see the study's default text rather than this video's own. */
  use_default_task: boolean
  use_default_info: boolean
}

export interface AdminParticipant {
  id: string
  status: string
  slot_count: number
  /** The set they were dealt at first login or given by hand; null before that
   *  or when their sequence was hand-picked instead. */
  video_set_id: number | null
  video_set_name: string | null
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
  video_set_id: number | null
  video_set_name: string | null
  /** Pinned when the run opened; null until then. */
  think_aloud_batch_size: number | null
}

export interface VideoSetItem {
  slot_index: number
  video_id: number
  video_title: string
  phase_type: string
}

/** One of a study's fixed video orders — "A" or "B" — dealt out half and half. */
export interface VideoSet {
  id: number
  study_id: number
  name: string
  items: VideoSetItem[]
  participant_count: number
}

export interface AdminQuestionnaire {
  id: number
  study_id: number
  placement: string
  title: string
  description: string
  /** The instrument the page belongs to ("Demographics", "CK-Pretest"); the
   *  time on a section's pages is added up under it. Empty: stands alone. */
  section: string
  order_index: number
  questions: unknown[]
}

export interface ScreenSummary {
  id: number
  status: 'recording' | 'stored' | 'failed'
  error: string | null
  duration_ms: number | null
  byte_size: number | null
  /** "bridge" (ffmpeg on the lab machine) or "browser" (the page's own fallback). */
  recorder: 'bridge' | 'browser'
}

/** Which endpoint plays this row back: the gaze recording, or the capture alone. */
export interface ReplayRef {
  kind: 'gaze' | 'screen'
  id: number
}

export interface GazeRow {
  replay: ReplayRef
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
  recorder: 'bridge' | 'browser' | null
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

/** One day on an activity timeline. */
export interface ActivityDay {
  date: string
  events: number
  participants: number
}

export interface EventTypeCount {
  event_type: string
  /** The study's data-dictionary name for it; empty for events that are ours. */
  variable_name: string
  count: number
  participants?: number
}

export interface StudyStatRow {
  id: number
  name: string
  is_active: boolean
  created_at: string | null
  participants: number
  registered: number
  active: number
  completed: number
  started: number
  finished: number
  completion_rate: number | null
  avg_session_minutes: number | null
  videos: number
  videos_with_file: number
  video_seconds: number
  questionnaires: number
  notes: number
  note_writers: number
  diagnoses: number
  responses: number
  events: number
  last_activity_at: string | null
  gaze_recordings: number
  gaze_samples: number
  screen_recordings: number
  screens_stored: number
  screens_failed: number
  screen_bytes: number
  calibrations: number
  calibrations_ok: number
  mean_offset: number | null
}

export interface OverviewStats {
  generated_at: string
  totals: {
    studies: number
    active_studies: number
    researchers: number
    participants: number
    registered: number
    active: number
    completed: number
    started: number
    finished: number
    completion_rate: number | null
    videos: number
    videos_with_file: number
    questionnaires: number
    notes: number
    diagnoses: number
    responses: number
    events: number
    gaze_recordings: number
    gaze_samples: number
    screen_recordings: number
    screens_stored: number
    screens_failed: number
    screen_bytes: number
    calibrations: number
    calibrations_ok: number
  }
  studies: StudyStatRow[]
  activity: ActivityDay[]
  events_by_type: EventTypeCount[]
}

export interface CaseStats {
  video_id: number
  title: string
  phase_type: string
  duration_seconds: number | null
  time_limit_seconds: number | null
  has_file: boolean
  assigned: number
  viewers: number
  avg_watch_seconds: number | null
  median_watch_seconds: number | null
  avg_on_screen_seconds: number | null
  avg_coverage: number | null
  plays: number
  pauses: number
  seeks: number
  replays: number
  completions: number
  info_opens: number
  task_opens: number
  notes: number
  note_writers: number
  avg_note_chars: number | null
  diagnoses: number
  avg_diagnosis_chars: number | null
  avg_diagnosis_seconds: number | null
  gaze_recordings: number
  gaze_participants: number
  gaze_samples: number
  screen_recordings: number
  screens_stored: number
  screens_failed: number
  screen_bytes: number
}

export interface RosterRow {
  id: string
  status: string
  created_at: string | null
  cases: number
  assigned_sequence: boolean
  video_set: string | null
  step: number
  total_steps: number
  progress: number | null
  started_at: string | null
  completed_at: string | null
  session_minutes: number | null
  first_event_at: string | null
  last_event_at: string | null
  events: number
  notes: number
  note_chars: number
  diagnoses: number
  responses: number
  watch_seconds: number
  gaze_recordings: number
  gaze_samples: number
  screens_stored: number
  screens_failed: number
  screen_bytes: number
  calibrations: number
  best_offset: number | null
}

export interface BatteryStats {
  id: number
  title: string
  placement: string
  section: string
  questions: number
  responses: number
  participants: number
  expected: number
  completion: number | null
  avg_seconds: number | null
  last_response_at: string | null
}

export interface CalibrationBucket {
  attempts: number
  participants: number
  avg_offset: number | null
  best_offset: number | null
  worst_offset: number | null
  avg_offset_degrees: number | null
}

export interface StudyStats {
  generated_at: string
  study: {
    id: number
    name: string
    description: string
    is_active: boolean
    created_at: string | null
  }
  participants: {
    total: number
    registered: number
    active: number
    completed: number
    started: number
    completed_sessions: number
    completion_rate: number | null
    avg_progress: number | null
    avg_session_minutes: number | null
    median_session_minutes: number | null
    with_gaze: number
    with_screen: number
    with_calibration: number
    never_started: number
  }
  data: {
    notes: number
    note_chars: number
    diagnoses: number
    responses: number
    events: number
    gaze_recordings: number
    gaze_samples: number
    screens_stored: number
    screens_failed: number
    screen_bytes: number
    watch_seconds: number
  }
  cases: CaseStats[]
  questionnaires: BatteryStats[]
  sections: StudySectionTime[]
  calibration: {
    attempts: number
    participants: number
    by_status: Record<string, CalibrationBucket>
  }
  roster: RosterRow[]
  activity: ActivityDay[]
  events_by_type: EventTypeCount[]
}

export interface ParticipantCaseStats {
  slot_index: number
  video_id: number
  title: string
  phase_type: string
  duration_seconds: number | null
  time_limit_seconds: number | null
  entered: boolean
  /** Seconds the clip was actually playing. */
  watch_seconds: number
  /** Seconds the case screen was up — reading, typing and dialogs included. */
  on_screen_seconds: number
  max_playhead_seconds: number
  play_spans: number
  coverage: number | null
  plays: number
  pauses: number
  seeks: number
  replays: number
  completed: boolean
  info_opens: number
  task_opens: number
  notes_focused: number
  typing_bursts: number
  notes: {
    snapshots: number
    chars: number
    last_at: string | null
    last_video_time: number | null
  }
  diagnosis: {
    chars: number
    words: number
    seconds: number | null
    submitted_at: string | null
  } | null
  outro_answered: boolean
  ratings_answered: boolean
  gaze: {
    recordings: number
    samples: number
    sampling_rate_hz: number | null
    expected_samples: number | null
    /** Samples captured as a percentage of what the tracker should have produced. */
    yield: number | null
    started_at: string | null
    completed_at: string | null
  }
  screen: {
    id: number
    status: string
    error: string | null
    duration_ms: number | null
    byte_size: number | null
    width: number | null
    height: number | null
    fps: number | null
    recorder: 'bridge' | 'browser'
  } | null
}

/** One person's time on one section: every page of it they answered, added up. */
export interface ParticipantSectionTime {
  section: string
  pages: number
  seconds: number | null
  pre_test: boolean
}

/** A section across the study: totals per person first, then the average and
 *  median over people — how long the pre-test takes someone. */
export interface StudySectionTime {
  section: string
  pages: number
  pre_test: boolean
  participants: number
  avg_seconds: number | null
  median_seconds: number | null
}

export interface ParticipantStats {
  generated_at: string
  id: string
  study_id: number
  study_name: string
  status: string
  created_at: string | null
  session: {
    started_at: string | null
    completed_at: string | null
    minutes: number | null
    step: number
    total_steps: number
    progress: number | null
    current_step: string | null
    assigned_sequence: boolean
    video_set: string | null
  }
  activity: {
    events: number
    first_at: string | null
    last_at: string | null
    minutes: number | null
  }
  totals: {
    cases: number
    cases_entered: number
    cases_completed: number
    watch_seconds: number
    on_screen_seconds: number
    notes: number
    note_chars: number
    diagnoses: number
    diagnosis_words: number
    responses: number
    gaze_samples: number
    screens_stored: number
    screens_failed: number
    screen_bytes: number
  }
  cases: ParticipantCaseStats[]
  questionnaires: {
    id: number
    response_id: number
    title: string
    placement: string
    section: string
    video_id: number | null
    video_title: string | null
    questions: number
    answered: number
    seconds: number | null
    created_at: string | null
  }[]
  sections: ParticipantSectionTime[]
  calibrations: {
    id: number
    status: string
    mean_offset: number | null
    mean_offset_degrees: number | null
    points: number
    created_at: string | null
  }[]
  events_by_type: (EventTypeCount & { first_at: string | null; last_at: string | null })[]
}

export interface SequenceItemInput {
  video_id: number
  slot_index: number
  phase_type: string
}

export const EXPORT_KINDS = [
  'participants',
  'videos',
  'notes',
  'diagnoses',
  'responses',
  'events',
  'gaze',
  'calibration',
] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

export interface ExportInfo {
  kind: ExportKind
  filename: string
  rows: number
  // False where the study never collected this at all — in-app eye-tracker
  // calibration is off — so an empty file is the expected result, not a fault.
  collected: boolean
}

export interface VideoUploadInput {
  title: string
  phase_type: string
  task_description: string
  info_text: string
  student_task_text: string
  time_limit_seconds?: number | null
  use_default_task?: boolean
  use_default_info?: boolean
  file: File
}

/** Where a clip should go: a session in the bucket, or back through the app. */
export interface VideoUploadTarget {
  mode: 'resumable' | 'proxy'
  object_name: string
  upload_url: string | null
}

/**
 * Send the file to the bucket itself.
 *
 * XHR rather than fetch because it is the only way to see upload progress, and
 * raw rather than through `apiClient` because the session url is already the
 * whole authorisation — putting our own Authorization header on it would leak
 * the admin's token to a third party.
 */
function putToBucket(
  url: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`The upload was refused (${xhr.status}).`))
    }
    xhr.onerror = () => reject(new Error('The upload could not reach the storage bucket.'))
    xhr.onabort = () => reject(new Error('The upload was cancelled.'))
    xhr.send(file)
  })
}

export const adminApi = {
  listStudies: () => apiClient.get<Study[]>('/admin/studies').then((r) => r.data),
  createStudy: (body: Partial<Study>) =>
    apiClient.post<Study>('/admin/studies', body).then((r) => r.data),
  getStudy: (id: number) => apiClient.get<Study>(`/admin/studies/${id}`).then((r) => r.data),
  updateStudy: (id: number, body: Partial<Study>) =>
    apiClient.patch<Study>(`/admin/studies/${id}`, body).then((r) => r.data),
  deleteStudy: (id: number, force = false) =>
    apiClient.delete(`/admin/studies/${id}?force=${force}`).then((r) => r.data),

  listVideos: (studyId: number) =>
    apiClient.get<AdminVideo[]>(`/admin/studies/${studyId}/videos`).then((r) => r.data),
  uploadVideo: async (
    studyId: number,
    input: VideoUploadInput,
    onProgress?: (percent: number) => void,
  ): Promise<AdminVideo> => {
    const { file, ...meta } = input
    const opened = await apiClient
      .post<VideoUploadTarget>(`/admin/studies/${studyId}/videos/upload-url`, {
        filename: file.name,
        size_bytes: file.size,
        content_type: file.type || 'video/mp4',
      })
      .then((r) => r.data)

    if (opened.mode === 'resumable' && opened.upload_url) {
      // Straight to the bucket: a hosted backend will not carry a clip this
      // size, and the bytes have no reason to pass through it anyway.
      await putToBucket(opened.upload_url, file, onProgress)
      return apiClient
        .post<AdminVideo>(`/admin/studies/${studyId}/videos/finalize`, {
          ...meta,
          object_name: opened.object_name,
        })
        .then((r) => r.data)
    }

    // No bucket configured, so the app stores the file itself.
    const form = new FormData()
    form.append('title', meta.title)
    form.append('phase_type', meta.phase_type)
    form.append('task_description', meta.task_description)
    form.append('info_text', meta.info_text)
    form.append('student_task_text', meta.student_task_text)
    if (meta.time_limit_seconds != null) {
      form.append('time_limit_seconds', String(meta.time_limit_seconds))
    }
    form.append('use_default_task', String(!!meta.use_default_task))
    form.append('use_default_info', String(!!meta.use_default_info))
    form.append('file', file)
    return apiClient
      .post<AdminVideo>(`/admin/studies/${studyId}/videos`, form, {
        // Case clips run to hundreds of megabytes; a button that just sits
        // there looks broken.
        timeout: 0,
        onUploadProgress: (e) => onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
      })
      .then((r) => r.data)
  },
  deleteVideo: (id: number) => apiClient.delete(`/admin/videos/${id}`).then((r) => r.data),

  listParticipants: (studyId: number) =>
    apiClient.get<AdminParticipant[]>(`/admin/studies/${studyId}/participants`).then((r) => r.data),
  createParticipants: (studyId: number, ids: string[]) =>
    apiClient
      .post<{ created: string[]; skipped: string[] }>(`/admin/studies/${studyId}/participants`, {
        ids,
      })
      .then((r) => r.data),
  getParticipant: (id: string) =>
    apiClient.get<ParticipantDetail>(`/admin/participants/${id}`).then((r) => r.data),
  deleteParticipant: (id: string) =>
    apiClient.delete(`/admin/participants/${id}`).then((r) => r.data),
  setSequence: (id: string, items: SequenceItemInput[]) =>
    apiClient.put(`/admin/participants/${id}/videos`, { items }).then((r) => r.data),
  bulkAssign: (studyId: number, participant_ids: string[], items: SequenceItemInput[]) =>
    apiClient
      .post<{ applied: string[]; skipped: string[] }>(`/admin/studies/${studyId}/bulk-assign`, {
        participant_ids,
        items,
      })
      .then((r) => r.data),
  assignVideoSet: (id: string, videoSetId: number) =>
    apiClient
      .put<{ status: string; slot_count: number; video_set_name: string }>(
        `/admin/participants/${id}/video-set`,
        { video_set_id: videoSetId },
      )
      .then((r) => r.data),

  listVideoSets: (studyId: number) =>
    apiClient.get<VideoSet[]>(`/admin/studies/${studyId}/video-sets`).then((r) => r.data),
  createVideoSet: (studyId: number, body: { name: string; items: SequenceItemInput[] }) =>
    apiClient.post<VideoSet>(`/admin/studies/${studyId}/video-sets`, body).then((r) => r.data),
  updateVideoSet: (id: number, body: { name?: string; items?: SequenceItemInput[] }) =>
    apiClient.put<VideoSet>(`/admin/video-sets/${id}`, body).then((r) => r.data),
  deleteVideoSet: (id: number) => apiClient.delete(`/admin/video-sets/${id}`).then((r) => r.data),

  listQuestionnaires: (studyId: number) =>
    apiClient
      .get<AdminQuestionnaire[]>(`/admin/studies/${studyId}/questionnaires`)
      .then((r) => r.data),
  createQuestionnaire: (studyId: number, body: Partial<AdminQuestionnaire>) =>
    apiClient
      .post<AdminQuestionnaire>(`/admin/studies/${studyId}/questionnaires`, body)
      .then((r) => r.data),
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
      .get<{ items: GazeRow[] }>('/admin/gaze/recordings', {
        params: studyId ? { study_id: studyId } : {},
      })
      .then((r) => r.data.items),
  getReplay: (ref: ReplayRef) =>
    apiClient
      .get<AdminReplay>(
        ref.kind === 'gaze'
          ? `/admin/gaze/recordings/${ref.id}/replay`
          : `/admin/screen-recordings/${ref.id}/replay`,
      )
      .then((r) => r.data),
  listAudit: () => apiClient.get<{ items: AuditRow[] }>('/admin/audit').then((r) => r.data.items),

  overviewStats: (days = 30) =>
    apiClient.get<OverviewStats>('/admin/stats/overview', { params: { days } }).then((r) => r.data),
  studyStats: (studyId: number, days = 30) =>
    apiClient
      .get<StudyStats>(`/admin/studies/${studyId}/stats`, { params: { days } })
      .then((r) => r.data),
  participantStats: (id: string) =>
    apiClient.get<ParticipantStats>(`/admin/participants/${id}/stats`).then((r) => r.data),

  // `participantIds` limits an export to those people; absent means the whole
  // study. Sent as a repeated query key, which is how FastAPI reads a list.
  listExports: (studyId: number, participantIds?: string[]) =>
    apiClient
      .get<ExportInfo[]>(`/admin/studies/${studyId}/exports`, {
        params: exportParams(participantIds),
      })
      .then((r) => r.data),
  downloadExport: async (studyId: number, kind: ExportKind, participantIds?: string[]) => {
    const res = await apiClient.get(`/admin/studies/${studyId}/export/${kind}`, {
      params: exportParams(participantIds),
      responseType: 'blob',
    })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    // The server names the file for what it holds (events-TN-006.csv for one
    // person), so files on a laptop do not overwrite each other.
    a.download = filenameFrom(res.headers['content-disposition']) ?? `${kind}.csv`
    a.click()
    URL.revokeObjectURL(url)
  },
}

function exportParams(participantIds?: string[]): URLSearchParams | undefined {
  if (!participantIds?.length) return undefined
  const params = new URLSearchParams()
  for (const id of participantIds) params.append('participant_ids', id)
  return params
}

export function filenameFrom(contentDisposition: unknown): string | null {
  if (typeof contentDisposition !== 'string') return null
  const match = /filename="([^"]+)"/.exec(contentDisposition)
  return match ? match[1] : null
}
