import apiClient from './client'
import type { GazeGeometry } from '../lib/gazeGeometry'

// Canonical wire format, shared with the Tobii bridge and the backend. Coords
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
  startRecording: (data: {
    video_id: number
    sampling_rate_hz: number
    geometry?: GazeGeometry | null
  }) => apiClient.post<StartRecordingResponse>('/gaze/recordings', data).then((r) => r.data),
  uploadSamples: (recordingId: number, samples: GazeSample[]) =>
    apiClient.post(`/gaze/recordings/${recordingId}/samples`, { samples }),
  addGeometry: (recordingId: number, geometry: GazeGeometry) =>
    apiClient.post(`/gaze/recordings/${recordingId}/geometry`, geometry),
  saveCalibration: (data: CalibrationRecord) => apiClient.post('/gaze/calibration', data),
  completeRecording: (recordingId: number, data: { sample_count: number }) =>
    apiClient.patch(`/gaze/recordings/${recordingId}/complete`, data),
}
