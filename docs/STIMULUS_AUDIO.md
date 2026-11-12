# Stimulus audio in retrospective replay

New case recordings contain the students' soundtrack as the case video actually
played. The agreed target is Windows Chrome/Edge. Media-element mute and volume
changes are preserved. Downloads, participant think-aloud and admin replay all
play the same recording. No microphone permission or narration recording is used.
Historical recordings remain unchanged.

## Capture rather than playback-log reconstruction

The case video's decoded output is routed through Web Audio to both the normal
speakers and a recording destination. A continuous silent source keeps that
destination alive before playback, while paused or buffering, and after the clip
ends. Seeking and replaying passages change the actual source sound, so they are
recorded in their original order. The application never starts a second copy of
the stimulus at replay time zero.

The browser fallback combines this audio track with the held whole-display video
track in one MediaRecorder. The screen-share request deliberately remains
`audio: false`: screen/system audio could include notifications or other apps.
Only the case element supplies the recording's sound.

With the bridge, the browser records the same live audio as an audio-only
MediaRecorder stream. The owning screen WebSocket sends bounded binary chunks
to a temporary file. After the final chunk and capture status arrive, the bridge
stops the screen capture and uses the bundled FFmpeg to combine them. It copies
the video stream, trims or delays the audio using the difference between their
wall-clock anchors, and pads the end with silence. The result is the existing
MP4, now with AAC sound; the temporary audio file is not a separate research
asset. FFprobe verifies audio packets before and after muxing.

This preserves the bridge recording epoch, gaze timestamps, video duration metadata,
storage names, upload authorization, local/GCS delivery, replay selection, and
native download routes. Seeking the replay seeks one audiovisual file; gaze and
notes continue to follow that file's existing time coordinate.

Reconstructing from playback events was rejected for new recordings: those logs
do not describe every buffering interval, and would silently turn an inferred
timeline into apparent evidence. Reconstruction of historical sessions would
need a separate research decision and explicit accuracy limits.

The relevant API behavior is specified in the
[Web Audio media-element source definition](https://www.w3.org/TR/webaudio-1.1/#MediaElementAudioSourceNode)
and [MediaRecorder specification](https://www.w3.org/TR/mediastream-recording/).
Audio alignment uses FFmpeg's
[trim, delay and padding filters](https://ffmpeg.org/ffmpeg-filters.html).

## What audio status means

`screen_recordings.audio_status` and `audio_error` are separate from upload
`status`. They travel through local multipart uploads and GCS completion, then
through participant/admin replay and recording listings.

| Value | Meaning |
| --- | --- |
| `captured` | The capture observed a nonzero stimulus signal without a detected capture failure. The bridge additionally verified encoded packets and successful muxing. |
| `silent` | Capture completed but observed no audible signal. This can mean intentional mute, a silent source, or an inaccessible soundtrack; it warrants review. |
| `failed` | An encoder, audio clock, track, connection, transfer, or muxing failure was detected. The video can still be retained. |
| `unavailable` | This capture path could not provide stimulus audio. |
| `unknown` | Legacy capture or a client that did not report audio health. Successful file delivery does not upgrade it. |

Participants can continue when capture fails, with a visible notice. Replay also
warns when audio is silent, failed, unavailable or unknown. An old bridge is
detected by the missing `stimulus_audio` capability and requests an update.
The backend stores capture-reported health; it does not download every GCS object
to independently inspect its soundtrack. A nonzero signal is not a guarantee
that every spoken word was intelligible. Listen to a test recording before data
collection.

## Permissions and limits

- Start through the case intro button. It resumes the AudioContext during a user
  gesture, before network requests. Playback also attempts resume. Reloading
  straight into an active case can begin with a suspended audio clock; such a
  capture is flagged as failed rather than reported as complete sound.
- Cross-origin stimuli use `crossOrigin="anonymous"`. The media server must
  permit the exact frontend origin for GET/HEAD. For LRZ this is
  `https://a04.rdm.lab.lrz.de`. Check both backend `FRONTEND_URL` and bucket CORS;
  ordinary video playback working without CORS was not sufficient for Web Audio.
  A load failure retries once in a fresh native player without audio capture,
  preserving the playhead, mute and volume and showing a failed-audio warning.
- The page needs HTTPS (or localhost), display-capture permission for browser
  fallback, and access to the local bridge when using it. Browser local-network
  permissions and the deployed CSP must allow the configured localhost socket.
  Chromium can block the connection before the bridge receives a handshake, so
  an empty bridge log does not rule out a browser permission problem.
  Select the entire display, as before, to preserve gaze geometry.
- Preserve **element** mute/volume. OS master volume, hardware headphone volume,
  disconnected speakers, and some browser/tab-level muting occur outside this
  graph and cannot establish what reached the participant's ears. Do not equate
  the capture with a measurement of physical audibility.
- New browser/audio captures anchor their clock at the `MediaRecorder.start()`
  call. The `start` event is queued asynchronously and was observed over 300 ms
  later in installed Chrome; using it as the epoch shifted gaze and audio.
  Existing recordings and the bridge screen epoch are unchanged. The browser
  invocation and existing FFmpeg progress anchor are still estimates. This does
  not promise sample-accurate audio/gaze timing;
  validate acceptable drift and output-device latency on the lab setup.
- Chromium uses WebM/Opus for browser capture and audio transfer; the bridge
  produces H.264/AAC MP4. MIME support is checked at runtime. Other platforms
  and browsers are not certified by this change.
- Audio is finalized before closing the bridge socket during normal navigation.
  Closing the tab/browser or losing the socket can truncate audio; incomplete
  bridge transfers are flagged and the video is retained. Background suspension
  and encoder failures are not repaired from event logs.

## Release and lab acceptance

1. Deploy the backend migration `e6a2b8c4d0f1` and the matching backend/frontend.
   Existing rows become `unknown`, not `captured`.
2. Verify media CORS for the actual LRZ origin. Keep existing PUT/POST upload
   methods and any other production origins when updating a bucket rule.
3. On Windows, rebuild from the Python 3.10 environment with the Tobii SDK:
   `.\.venv310\Scripts\python.exe build_package.py` from `tobii-service`. The build
   checks its FFmpeg codecs and bundled tools, then launches the frozen executable
   to verify the LRZ handshake and synthetic gaze without recording the desktop.
   Distribute the complete rebuilt
   `A04Bridge-win64.zip` folder and replace the old package on **every** lab PC.
   A website deployment cannot update an already distributed executable.
4. Calibrate the tracker in Eye Tracker Manager, close that application, then
   start the new bridge before opening the study. Its allowlist now includes
   the confirmed LRZ origin `https://a04.rdm.lab.lrz.de`. A rejected origin could
   explain browser fallback
   and zero gaze recording headers, but this is not a confirmed hardware diagnosis.
   `(tobii)` in the title alone does not prove
   that a tracker was discovered. Confirm gaze samples and saved counts.
   The live site checked on 12 November 2026 connects to `ws://127.0.0.1:8766`,
   while the bridge defaults to 8765. Start it with `--port 8766` for that
   deployment, or rebuild the frontend and its CSP consistently for 8765.
   The compiled socket URL, CSP and bridge listening port must agree.
5. In current Windows Chrome and Edge, test both the bridge and browser fallback.
   Include a delayed start, 0–15 s playback, 20 s pause, rewind to 5 s, replayed
   passage, forward seek, mute/volume changes, stimulus end, and further notes.
   Listen to participant replay, admin replay and a downloaded file. Seek into
   each segment and confirm gaze still aligns. Repeat with a long case to check
   drift, and record browser versions, display scaling and device models.
6. Test denied display/local-network permissions, old bridge, CORS failure,
   interrupted socket and silent stimulus. A stored video must still show the
   corresponding audio warning. Confirm no microphone prompt and no unrelated
   application audio in the recording.

Automated checks run real Chromium and FFmpeg on the development host, not the
Windows desktop capture device or Tobii hardware. The packaged Windows executable,
physical gaze alignment, native picker permissions and production media CORS
remain required lab checks before declaring the release ready for collection.

## Repeatable verification

See [the detailed validation record](AUDIO_VALIDATION_2026-11-12.md) for the latest
suite counts, real-media checks, defects found and remaining lab checks. These
development checks do not certify Windows hardware or the distributed executable.

- Backend: `pytest`; `ruff check .`; `ruff format --check .`; `mypy`;
  `alembic upgrade head` and `alembic check` on a disposable database.
- Frontend: `npm run test`; `npm run typecheck`; `npm run lint`; `npm run build`;
  `npm run e2e` with the existing test database setup.
- Bridge: `pytest -q` with FFmpeg/FFprobe installed. Real-media tests inspect
  delayed and trimmed sound, pause/repeat sequences, trailing silence and video
  stream preservation; origin tests exercise a real loopback WebSocket.
- From the repository root: `node scripts/verify_stimulus_audio.mjs` and
  `node scripts/verify_stimulus_audio.mjs --bridge`. Set `A04_PYTHON` to a Python
  environment with the bridge dependencies if `backend/.venv/bin/python` is not
  available. These checks run in CI as well. The harness generates
  a two-tone stimulus, runs Chromium against the actual capture code, saves the
  delivered media and a JSON evidence report, and checks delays, seeks, volume,
  mute and silence by decoding the result. Browser mode uses a canvas display;
  bridge mode uses FFmpeg's test pattern and a real WebSocket/upload receiver.
  Neither replaces the Windows screen-share permission test.
