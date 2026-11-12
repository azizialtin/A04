# A04 stimulus audio validation — 12 November 2026

This record distinguishes automated and development-host evidence from Windows
lab acceptance. Tests used generated tones, synthetic participants and disposable
databases. No production participant data was modified and nothing was deployed.

## Completed regression suites

| Check | Result | Environment / qualification |
| --- | --- | --- |
| Backend | 642 passed | Linux production base, Python 3.11.18, PostgreSQL 15 |
| Backend coverage gate | 78.72%; required 78% | Existing threshold retained |
| Frontend unit tests | 372 passed, 50 files | Final capture-clock, upload-wait and stable-selection changes included |
| Bridge | 81 passed per environment | macOS Python 3.13 / FFmpeg 8; Linux Python 3.10.21 / FFmpeg 7.1.5; includes corrected-origin follow-up |
| WebSocket dependency compatibility | 81 passed on each version | Python 3.10 with websockets 12.0 and 16.1.1; no skips |
| Participant end-to-end suite | 5 passed | Existing Playwright suite against a disposable live backend |
| Feedback browser suite | 23 passed | Existing UI, AOI and capture-fallback regressions |
| Backup unit tests | 4 passed | Existing backup selection and failure handling |
| Backend static checks | Passed | Ruff lint/format and mypy |
| Frontend static checks | Passed | TypeScript, Prettier, ESLint: zero errors, two existing warnings |
| Production builds | Passed | Frontend and backend Dockerfiles; no dependency additions |
| Frontend runtime checks | 21 passed | nginx syntax, SPA routes, MIME, caching, CSP, display capture, microphone/camera disabled |
| Backend runtime checks | Passed | Fresh migrations/schema match, non-root `app` user, readiness endpoint |
| Production dependency audits | No reported vulnerabilities | 44 npm production dependencies; 49 Python dependencies |

The distinct suite count is **1,127 tests**. Running the same bridge tests on
three configurations does not increase that count. Media analysis, HTTP checks
and operational checks below are additional evidence.

The new stimulus receiver/mux module reached 92% coverage; the bridge screen
recorder reached 83%, and the whole bridge reached 72%. Coverage is a measure of
executed code, not proof of hardware compatibility. An exploratory macOS Python
3.13 backend run passed its then-current 639 tests but reported 77.93% coverage,
below the gate. The final supported CI/runtime Python 3.11 run passed both the
642-test suite and its unchanged coverage gate; the Python 3.13 coverage
difference has not been attributed to a confirmed cause.

## Real media and storage checks

- Actual MediaRecorder, Web Audio, WebM/Opus encoding and FFmpeg H.264/AAC muxing
  were exercised. Both paths passed in Playwright Chromium 151.0.7922.34 and
  installed Google Chrome 157.0.8103.52 after the clock correction.
- Waveform analysis checked delayed playback, pause silence, rewind/repeated
  passages, forward seeking, player volume reduction, mute/unmute, stimulus end
  and silence while writing notes. A separately supplied 1500 Hz display-audio
  track was excluded. A microphone request would fail the harness.
- Native video playback sought into paused, repeated, forward and final-notes
  intervals. The decoded audio at each destination was checked; browser mode
  also checked the generated visual timeline.
- The literal reviewer sequence (play 0–15 s, pause 20 s, rewind to 5 s) passed.
  A ten-minute bridge recording measured about 60 ms initial audio offset and
  70 ms near second 597: about 10 ms accumulated drift. This run preceded the
  browser/audio invocation-anchor correction; both final Chrome capture paths
  were subsequently rechecked after that correction.
- The final Chrome browser capture lasted 601.297 seconds and produced an
  86,927,378-byte WebM. Audio onset offset measured 10 ms at the first cycle and
  10 ms near second 595: no measured accumulated drift at 10 ms resolution.
  Seven seeks checked the beginning, pause, repeated passage, forward seek,
  stimulus end and final repeated sound/silence through HTTP range delivery.
  The original large-Blob replay harness page closed after capture/waveform
  checks; the intact saved file was independently verified in a fresh browser
  using the application's HTTP delivery method. That harness interruption is
  not presented as an uninterrupted all-in-one pass.
- Real HTTP uploads of MP4 and WebM were fetched through participant replay and
  signed admin native-download routes. SHA-256 and complete bytes matched.
  Range requests returned 206 with the correct first 1,024 bytes.
- Participant and admin replay retained the recording epoch, duration, audio
  status and gaze points. Samples at epoch +500 ms and +2,000 ms remained at
  those positions; the raw gaze export contained both samples. Unauthorized
  admin access returned 401. Local configured-origin CORS passed.
- Database migrations and model/schema comparison were exercised on fresh
  disposable PostgreSQL databases. Migration tests also cover existing records
  remaining `unknown` and downgrade/upgrade behavior.
- A complete three-case session used the real UI, API, database, storage, bridge
  protocol, participant replay, gaze checkbox, admin replay and native download.
  It verified successful audio, real cross-origin media denial with native
  playback fallback and a visible failure warning, then successful audio again
  in the next case. All three retained nonzero synthetic gaze samples.
- In that session a real HTTP stall froze an unpaused video for 6.3 seconds.
  No `waiting` event was emitted, but waveform analysis found exactly zero RMS
  within the corresponding recorded interval. This directly tests the gap in
  playback-log reconstruction. A source file without any audio stream was also
  recorded through both capture paths and correctly reported as `silent`.
  The complete session was rerun on the final replay-selection code and passed;
  its measured buffering interval was 6.2 seconds, again with zero RMS.
- The actual backup script backed up the synthetic QA database and local media.
  A restore into a separate database preserved every public table's complete
  row contents, including audio status and timestamps. SHA-256 matched for all
  314 archived media files.

## Defects found and corrected during the extended run

1. A fast transition into think-aloud could select the original clip while the
   bridge was still muxing/uploading, then retain that fallback indefinitely.
   Replay now exposes whether the latest capture is pending. The page polls
   within its existing total 60-second wait budget. Stored, failed, historical,
   old-abandoned and newer-pending attempts are covered by regression tests.
   Once playback is exposed, its selected recording is held stable: late poll
   responses and focus/reconnect refreshes cannot replace a playing fallback.
   A new case visit obtains a fresh selection, including a rapid return to a
   previously visited case.
2. Installed Chrome delayed `MediaRecorder.onstart` by over 300 ms. Treating that
   event as capture time shifted the wall-clock/gaze mapping. New browser and
   audio-only captures now anchor at the synchronous `start()` invocation.
   Existing recordings and the native screen recorder's epoch are unchanged.
3. Screen startup could race between sockets and overwrite ownership of a
   running FFmpeg process. Ownership is reserved before awaiting startup;
   cancellation and stop-timeout cleanup are tested with real FFmpeg.
4. Unwritable recovery folders could discard the only copy after upload failure.
   The bridge now retains the original temporary file when moving it fails,
   uses unique recovery names and reports the retained path.
5. GCS resumable responses without a Range header could be interpreted as
   committed data; repeated no-progress responses could loop indefinitely.
   Missing/malformed/impossible ranges and no-progress retries are handled and
   tested. Actual production GCS access was not exercised.
6. WebSocket 12/13 used a different origin-header API than newer versions.
   Both supported APIs are handled, with strict allowed/denied-origin tests.
7. Truncated audio could produce a zero FFmpeg exit code alongside an error
   diagnostic. Structural errors now fail capture validation. A single exact
   Opus probe diagnostic, also observed for complete FFmpeg-generated files, is
   tolerated only on successful exit; complete real Chrome sidecars pass.
8. Encoder errors, unexpected stops, final-flush exceptions, absent stop events,
   a missing bridge acknowledgement and ended display sharing could hang or
   leave misleading audio health. Finalization is bounded and incomplete
   captures report failure. Navigation closes are handled without spurious
   bridge tracebacks.
9. Audio warnings and signal state could leak between cases. Capture generation
   guards and fresh native-player fallback isolate subsequent cases.

## Limits and release acceptance

The development media harness substitutes a canvas or FFmpeg test pattern for
the desktop and synthetic gaze for the tracker. Those substitutions are
explicit; a passing waveform test does not demonstrate physical speaker output,
Windows capture permissions or Tobii accuracy.

These checks remain **unverified** and require the actual lab setup:

- Build and run the frozen Windows executable with the vendor Tobii SDK; test
  the delivered ZIP, bundled FFmpeg/FFprobe and both physical tracker models.
- Exercise the native display picker and local-network permission with the
  deployed site in Windows Chrome **and** Edge, including denied permission.
- Verify authenticated stimulus bucket CORS and real GCS resumable delivery.
  Public reachability, TLS and response headers were subsequently checked at the
  corrected hostname; see the production follow-up below.
- Check physical gaze alignment, output-device latency, sleep/backgrounding and
  the longest planned case on the lab hardware. Element mute/volume is captured;
  OS/headphone volume and physical audibility are outside the audio graph.

No existing recording gains audio from these changes. Deploying the website does
not update a distributed `.exe`. Use the release steps in
[STIMULUS_AUDIO.md](STIMULUS_AUDIO.md) before collecting research sessions.

## Production hostname follow-up

The user confirmed `https://a04.rdm.lab.lrz.de/` (`rdm`, not the initially misread
`drm`). A read-only HTTPS request returned 200 on 12 November 2026. The bridge
allowlist, Windows package text/smoke check and origin tests now use that exact
origin. The old misspelling is explicitly rejected by a regression test.

The deployed JavaScript connects to `ws://127.0.0.1:8766`, and the live CSP permits
only the localhost/127.0.0.1 sockets on 8766. The bridge default and reviewer
screenshot use 8765. These cannot connect without matching the ports. For this
current deployment, run the bridge with `--port 8766`; alternatively rebuild the
frontend and configure its CSP for the bridge's 8765 default. Do not infer that
`(tobii)` in the console proves an active browser connection.

The live JavaScript and public API schemas do not contain this audio
implementation: the Web Audio capture/protocol and audio-health fields are
absent. The deployment has its own `recording_pending` replay polling, distinct
from this checkout's `screen_recording_pending` field. Its public
`/api/health/ready` endpoint returned 200 with status `ok`. Public inspection
does not verify authenticated stimulus media or hardware. No live configuration
was changed and no release was deployed during this follow-up.

## Reproducing and reviewing evidence

The development evidence directory is `/private/tmp/a04-qa-evidence`. It contains
suite logs, coverage JSON, generated recordings, waveform reports and Docker
smoke results. It is temporary local evidence, not an uploaded study artifact.

Useful entry points:

```sh
# Full unit/integration suites and static checks: see CONTRIBUTING.md.
node scripts/verify_stimulus_audio.mjs
node scripts/verify_stimulus_audio.mjs --bridge
node scripts/verify_stimulus_audio.mjs --literal --soak-seconds=600
A04_BROWSER_CHANNEL=chrome node scripts/verify_stimulus_audio.mjs
node scripts/verify_stimulus_audio.mjs --silent-source
node scripts/verify_stimulus_audio.mjs --delay-start-handler-ms=350
# Independently verify an existing saved capture over HTTP range delivery:
node scripts/verify_audio_recording.mjs /path/to/evidence-directory
# Requires a disposable running API and synthetic QA administrator:
node scripts/verify_audio_session.mjs
```

Set `A04_AUDIO_EVIDENCE_DIR` to preserve media reports outside temporary storage,
`A04_PYTHON` to select the bridge environment, and the full-session harness's
`A04_QA_API`, `A04_QA_APP`, `A04_QA_EMAIL`, `A04_QA_PASSWORD` variables for a
dedicated local test stack. Do not point that seeding harness at production.
