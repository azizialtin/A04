import { useEffect } from 'react'

import { screenApi } from '../api/screen'
import { TOBII_WS_URL } from '../lib/tobii'

/**
 * Records the lab machine's screen for as long as a case clip is on screen, so
 * the think-aloud can replay what the participant actually did — the clip, the
 * cursor, the notes box, the info dialogs — rather than the clip alone.
 *
 * The capture itself runs in the bridge. It has to: ffmpeg draws the cursor
 * into the frames, which a tab capture cannot, and the bridge holds the wall
 * clock that stamps the gaze samples, which is what lets the dot be drawn on
 * top afterwards. All this hook does is open a recording, hand the bridge a
 * token good for uploading that one file, and say when to stop.
 *
 * Best-effort throughout: no bridge, no ffmpeg, or a capture that will not
 * start leaves the case screen untouched and the think-aloud falling back to
 * the clip. It never blocks the participant.
 */
export function useScreenRecording(videoId: number) {
  useEffect(() => {
    let cancelled = false
    let recordingId: number | null = null

    let ws: WebSocket
    try {
      ws = new WebSocket(TOBII_WS_URL)
    } catch {
      return undefined
    }

    const fail = (error: string) => {
      const id = recordingId
      recordingId = null
      // Left unsaid, the row sits at "recording" and reads as a capture still
      // in flight rather than one that never happened.
      if (id != null) void screenApi.markFailed(id, error).catch(() => {})
    }

    const begin = async () => {
      let started
      try {
        started = await screenApi.start(videoId)
      } catch {
        return // the backend would not open one; there is nothing to mark failed
      }
      if (cancelled) {
        void screenApi
          .markFailed(started.recording_id, 'the case ended before recording began')
          .catch(() => {})
        return
      }
      recordingId = started.recording_id
      ws.send(
        JSON.stringify({
          type: 'start_screen_recording',
          upload_url: screenApi.uploadUrl(started.recording_id),
          // The bridge reports its own late failures: by the time ffmpeg has
          // finished, this page is gone.
          failed_url: screenApi.failedUrl(started.recording_id),
          token: started.upload_token,
        }),
      )
    }

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        return
      }

      if (msg.type === 'status') {
        if (msg.screen_recording && recordingId === null) void begin()
        return
      }
      if (msg.type === 'screen_recording_started' && !msg.ok) {
        fail(String(msg.error ?? 'the bridge could not start recording'))
      }
    }

    return () => {
      cancelled = true
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stop_screen_recording' }))
        }
        // Closing without the message above is survivable — the bridge stops a
        // capture whose browser has gone — but it costs the last few seconds.
        ws.close()
      } catch {
        /* already gone */
      }
    }
  }, [videoId])
}
