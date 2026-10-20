import apiClient from './client'
import type { GazeLayout } from '../lib/gazeGeometry'

export interface GazeContext {
  video_id: number | null
  step_kind: 'case_video' | 'questionnaire' | 'diagnosis' | 'case_outro'
  step_index: number
  questionnaire_id?: number | null
}

// Bridge samples with the browser's observed geometry reference. Coordinates
// are null on blink / track-loss.
export interface GazeSample {
  ts: number
  lx: number | null
  ly: number | null
  rx: number | null
  ry: number | null
  lv: boolean
  rv: boolean
  lpd?: number | null
  rpd?: number | null
  device_ts?: number | null
  // The observed layout for this sample; null means no unambiguous layout was available.
  geometry_ts?: number | null
}

export interface StartRecordingResponse {
  recording_id: number
}

export interface CalibrationRecord {
  status: 'success' | 'failed' | 'skipped'
  mean_offset: number | null
  mean_offset_degrees: number | null
  points: {
    target_x: number
    target_y: number
    gaze_x: number | null
    gaze_y: number | null
    offset: number | null
    samples: number
  }[]
}

export const gazeApi = {
  startRecording: (
    data: GazeContext & {
      sampling_rate_hz: number
      geometry?: GazeLayout | null
    },
  ) => apiClient.post<StartRecordingResponse>('/gaze/recordings', data).then((r) => r.data),
  uploadSamples: (recordingId: number, samples: GazeSample[], offset?: number) =>
    apiClient.post(`/gaze/recordings/${recordingId}/samples`, {
      samples,
      ...(offset === undefined ? {} : { offset }),
    }),
  addGeometry: (recordingId: number, geometry: GazeLayout) =>
    apiClient.post(`/gaze/recordings/${recordingId}/geometry`, geometry),
  saveCalibration: (data: CalibrationRecord) => apiClient.post('/gaze/calibration', data),
  completeRecording: (recordingId: number, data: { sample_count: number }) =>
    apiClient.patch(`/gaze/recordings/${recordingId}/complete`, data),
}
