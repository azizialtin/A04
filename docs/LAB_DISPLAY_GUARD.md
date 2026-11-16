# Local lab display guard

The deployed release and Windows bridge are frozen at
`35fa85beeb44b77a39be6834679d593d44c9fa05`. The display guard is a separate local
change on `codex/display-guard-20261116`; it has not been deployed or pushed.

## Run locally

Start the backend from this same checkout with the usual local database/media
configuration. Point `frontend/.env.local` at that local backend, then run:

```sh
cd frontend
npm run dev:lab
```

`VITE_LAB_DISPLAY_GUARD=true` also enables the guard explicitly. Normal `npm run
dev` and production builds remain unchanged unless that build-time flag is set.
Do not test the guarded frontend against the older deployed backend: the local
backend contains the matching export and replay exclusions.

The lab profile expects one display at 1920 × 1080, Windows scaling 100%, Edge
zoom 100%, a fullscreen viewport and window at screen origin (0, 0). Browser
fullscreen (F11) and the page's fullscreen button are both supported. If the
browser exposes `screen.isExtended`, an extended desktop is rejected. The
operator must still confirm the physical tracker/display pairing; a browser
cannot identify the calibrated physical monitor from its dimensions alone.

## Participant behavior

- Entry into the first gaze-recording page requires valid settings for at least
  500 ms and explicit **Studienleitung: Fortsetzen** confirmation. Correct
  settings alone do not dismiss the guard. The required pages follow the same
  capture definition as the recorder: in-app questionnaires, video cases,
  diagnosis pages and case-outro pages with an assigned questionnaire.
- Welcome, text/instruction pages, section and case introductions, phase
  transitions, and outros without a questionnaire remain usable at any display
  size. They monitor settings silently. Verification carries across them when
  settings remain valid, so ordinary instructions do not add another popup.
  A display or focus change silently revokes verification; the next measured
  page then waits for confirmation before mounting or starting its visit/timer.
- Resize, zoom, movement, fullscreen changes, and focus loss on measured pages
  block participant input. Ctrl/Cmd plus/minus and Ctrl-wheel are intercepted
  while guarded; Ctrl+0 remains available to restore zoom. Browser menus and OS
  controls cannot be completely disabled by a web page.
- The current page stays mounted, retaining its draft. Video pauses, without
  ending the recording or restarting playback automatically after recovery.
  The operator restores the display and explicitly resumes.
- CK's server deadline continues. Expiry saves the current draft through the
  existing finish-CK path, including retry behavior, and advances once. The next
  PCK page waits behind the guard until verification. Case deadlines also
  continue. Manual advance and supervisor navigation are blocked during an
  interruption.
- SoSci pages, think-aloud replay and the final page are exempt. SoSci can open
  in its separate tab. Returning from these pages requires fresh verification
  before measured content, including when an ordinary introduction is in between.
  Display-picker focus loss on introductory pages does not block their controls.
- In-app calibration remains disabled (`CALIBRATION_ENABLED=false`); calibrate
  externally before the first measured page. Its existing safety guard remains
  available if calibration is explicitly enabled in a future change. This scope
  change does not enable or move calibration, or change which pages record gaze.

The resume control is an operator acknowledgement, not an authenticated
supervisor login. Original research wording, MESP option order, PCK/MESP page
structure and ordinary layouts are unchanged.

## Gaze and replay behavior

The guard checks geometry on browser events, every 125 ms, before protected
actions, and on every received gaze sample. Queued resize/focus events also
invalidate verification when the display was restored before their handlers
ran. Their exclusion begins at a verified observation before the event; very
old delayed events conservatively fall back to the last verification time.

Raw samples, timestamps, coordinates, validity and pupil fields are retained.
Samples received while blocked have no geometry reference. Geometry snapshots
carry optional `display_guard` verification metadata. Durable interruption and
resume events use the participant event outbox and integer browser timestamps.

The backend combines those boundaries per participant, across recordings and
reloads. Delayed event delivery can therefore invalidate samples already
uploaded. Such samples remain in CSV with `mapping_reason` set to
`display_guard_interrupted` or `unverified_display`, and AOI `unmapped`.
Resuming requires a fresh verified geometry snapshot before AOI mapping resumes.

Both screen and clip replay return explicit suppression intervals, preventing
interpolation or a held gaze dot from bridging an uncertain interval. Raw
recording files are not rewritten. Historical recordings without guard metadata
retain their prior behavior. No database migration is required.

## Verification on the lab PC

1. Verify the bridge's real Fusion connection and 120 Hz samples; calibrate on
   the intended 15.6-inch display at the required settings.
2. Start a synthetic participant and walk through the unblocked introduction.
   Enter fullscreen and confirm the guard before the first measured page.
   Check known fixation targets on the video, notes, code, question, response
   controls and a popup; compare the exported AOIs and screen replay.
3. Resize or zoom during a draft and during video playback. Confirm the page
   blocks, the draft remains, video pauses, and restoration alone does not
   resume the task. Confirm no replay dot or mapped AOI appears in the excluded
   interval, while raw sample counts remain intact.
4. Open and return from SoSci. Confirm it works and the next required page asks
   for verification. During a separate synthetic CK run, leave the guard open
   across the deadline and confirm the partial answer saves once and PCK waits
   for resume.

Automated tests verify app behavior with synthetic gaze; physical accuracy,
calibration quality and actual Windows/Edge display pairing still require this
lab check. This guard prevents uncertain samples being presented as verified
mapping; it cannot guarantee the accuracy of an eye tracker or detect every
physical change to the lab equipment.

## Automated checks

```sh
cd frontend
npm run typecheck
npm run lint
npm test
npm run test:browser
npx playwright test --config playwright.guard.config.ts
```

The dedicated guard suite enables the feature and uses a 1920 × 1080 screen.
Its focus test uses a disposable Chromium process with genuine browser focus,
since normal Playwright contexts emulate an always-focused page. The existing
real-API Playwright suite checks complete pilot flow, exports, persisted timing
and page layouts against an isolated database. Backend guard tests cover late
events, duplicate boundaries, reloads, raw-row preservation, replay gaps and
legacy compatibility.
