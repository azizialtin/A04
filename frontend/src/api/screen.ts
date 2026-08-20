import apiClient from './client'

export interface StartScreenRecording {
  recording_id: number
  upload_token: string
}

/**
 * The bridge is a separate process on the lab machine, so the URLs we hand it
 * have to be absolute. `baseURL` may be either an origin or a path prefix;
 * resolving against the page's origin covers both.
 */
function absolute(path: string): string {
  const base = (apiClient.defaults.baseURL ?? '').replace(/\/$/, '')
  return new URL(`${base}${path}`, window.location.origin).toString()
}

export const screenApi = {
  start: (videoId: number) =>
    apiClient.post<StartScreenRecording>('/screen/recordings', { video_id: videoId }).then((r) => r.data),
  markFailed: (recordingId: number, error: string) =>
    apiClient.patch(`/screen/recordings/${recordingId}/failed`, { error }),
  uploadUrl: (recordingId: number) => absolute(`/screen/recordings/${recordingId}/upload`),
  failedUrl: (recordingId: number) => absolute(`/screen/recordings/${recordingId}/failed`),
}
