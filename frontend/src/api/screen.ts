import apiClient from './client'

export interface StartScreenRecording {
  recording_id: number
  upload_token: string
}

export type ScreenRecorder = 'bridge' | 'browser'

export interface ScreenRecordingMeta {
  epoch_ms: number
  duration_ms: number
  width: number | null
  height: number | null
  fps: number | null
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

/** A request carrying the one-recording upload token rather than the participant's. */
async function asUploader(url: string, token: string, init: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return res
}

export const screenApi = {
  start: (videoId: number, recorder: ScreenRecorder = 'bridge') =>
    apiClient
      .post<StartScreenRecording>('/screen/recordings', { video_id: videoId, recorder })
      .then((r) => r.data),
  markFailed: (recordingId: number, error: string) =>
    apiClient.patch(`/screen/recordings/${recordingId}/failed`, { error }),
  uploadUrl: (recordingId: number) => absolute(`/screen/recordings/${recordingId}/upload`),
  failedUrl: (recordingId: number) => absolute(`/screen/recordings/${recordingId}/failed`),
  // Where the bridge asks for somewhere in the bucket to put the capture, and
  // where it says what landed. A hosted backend will not carry a body the size
  // of a screen recording, so on those deployments the bytes never come here.
  sessionUrl: (recordingId: number) => absolute(`/screen/recordings/${recordingId}/upload-url`),
  completeUrl: (recordingId: number) => absolute(`/screen/recordings/${recordingId}/complete`),

  /**
   * Deliver a capture the page recorded itself, the same two ways the bridge
   * does: straight into the bucket where there is one, else through the app.
   */
  deliver: async (
    recordingId: number,
    token: string,
    file: Blob,
    meta: ScreenRecordingMeta,
  ): Promise<void> => {
    const contentType = file.type || 'video/webm'
    const opened = await asUploader(screenApi.sessionUrl(recordingId), token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size_bytes: file.size, content_type: contentType }),
    }).then((r) => r.json() as Promise<{ mode: string; upload_url: string | null }>)

    if (opened.mode === 'resumable' && opened.upload_url) {
      // No Authorization header here: the session url is the whole permission,
      // and our token has no business reaching a third party.
      const put = await fetch(opened.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: file,
      })
      if (!put.ok) throw new Error(`the bucket said ${put.status}`)
      // Retried, unlike the PUT: the capture is already in the bucket, and a
      // row left unconfirmed is a file nothing can ever reach again.
      let last: unknown
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await asUploader(screenApi.completeUrl(recordingId), token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...meta, content_type: contentType }),
          })
          return
        } catch (err) {
          last = err
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        }
      }
      throw last
    }

    const form = new FormData()
    form.append('epoch_ms', String(meta.epoch_ms))
    form.append('duration_ms', String(meta.duration_ms))
    if (meta.width != null) form.append('width', String(meta.width))
    if (meta.height != null) form.append('height', String(meta.height))
    if (meta.fps != null) form.append('fps', String(meta.fps))
    const ext = contentType === 'video/mp4' ? 'mp4' : 'webm'
    form.append('file', file, `screen.${ext}`)
    await asUploader(screenApi.uploadUrl(recordingId), token, { method: 'POST', body: form })
  },
}
