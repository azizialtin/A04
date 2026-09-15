import { useEffect } from 'react'

import { screenApi } from '../api/screen'
import {
  heldStream,
  noteBridgeCaptureFailed,
  startBrowserRecording,
  type BrowserRecording,
} from '../lib/screenCapture'
import { TOBII_WS_URL } from '../lib/tobii'

// A socket that neither opens nor errors — a firewall that drops rather than
// refuses, a stale VITE_TOBII_WS_URL — would otherwise leave the case
// unrecorded with the display already granted and nothing watching.
const BRIDGE_CONNECT_TIMEOUT_MS = 3000

/**
 * Records the lab machine's screen for as long as a case clip is on screen, so
 * the think-aloud can replay what the participant actually did — the clip, the
 * cursor, the notes box, the info dialogs — rather than the clip alone.
 *
 * The capture itself normally runs in the bridge. It has to: ffmpeg draws the
 * cursor into the frames, which a tab capture cannot, and the bridge holds the
 * wall clock that stamps the gaze samples, which is what lets the dot be drawn
 * on top afterwards. For that path all this hook does is open a recording, hand
 * the bridge a token good for uploading that one file, and say when to stop.
 *
 * When there is no bridge, or it says it cannot capture, the page records its
 * own display instead — provided the case intro managed to get hold of it (see
 * `lib/screenCapture.ts`). The tracker may be down, but the mouse and the notes
 * are still worth narrating over.
 *
 * Best-effort throughout: no bridge, no ffmpeg, no granted display, or a
 * capture that will not start leaves the case screen untouched and the
 * think-aloud falling back to the clip. It never blocks the participant.
 */
export function useScreenRecording(videoId: number) {
  useEffect(() => {
    let cancelled = false
    let recordingId: number | null = null
    // Which recorder has been committed to: nothing yet, the bridge, or the page.
    let mode: 'bridge' | 'browser' | null = null
    let browser: BrowserRecording | null = null

    const fallback = () => {
      if (mode !== null || cancelled) return
      const stream = heldStream()
      if (!stream) return
      mode = 'browser'
      browser = startBrowserRecording(videoId, stream)
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(TOBII_WS_URL)
    } catch {
      fallback()
      return () => {
        cancelled = true
        void browser?.stop()
      }
    }
    // `fallback` is a no-op once a recorder has been settled on, so this only
    // bites when the bridge has said nothing at all by now.
    const connectTimer = window.setTimeout(fallback, BRIDGE_CONNECT_TIMEOUT_MS)

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
        started = await screenApi.start(videoId, 'bridge')
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
          // Against a bucket the bridge PUTs the capture there itself and only
          // tells the backend what landed; `upload_url` is the fallback for a
          // deployment that stores files on its own disk.
          session_url: screenApi.sessionUrl(started.recording_id),
          complete_url: screenApi.completeUrl(started.recording_id),
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
        if (msg.screen_recording) {
          if (mode === null) {
            mode = 'bridge'
            void begin()
          }
        } else {
          fallback()
        }
        return
      }
      if (msg.type === 'screen_recording_started' && !msg.ok) {
        // It only promised ffmpeg on PATH; the device and the permission fail
        // here, once the case is already running. Nothing can be done for this
        // case, but the next intro can ask for the display instead.
        noteBridgeCaptureFailed()
        fail(String(msg.error ?? 'the bridge could not start recording'))
      }
    }
    // A bridge that is not there refuses the connection before it says
    // anything; that is the page's cue to record on its own.
    ws.onerror = fallback
    ws.onclose = fallback

    return () => {
      cancelled = true
      window.clearTimeout(connectTimer)
      try {
        ws.onclose = null
        ws.onerror = null
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stop_screen_recording' }))
        }
        // Closing without the message above is survivable — the bridge stops a
        // capture whose browser has gone — but it costs the last few seconds.
        ws.close()
      } catch {
        /* already gone */
      }
      void browser?.stop()
    }
  }, [videoId])
}
