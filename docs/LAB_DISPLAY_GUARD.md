# Lab display guard and native viewport mapping

The current Windows bridge measures the study page's content rectangle in
physical desktop pixels. The app combines that rectangle with the browser's
CSS layout and device-pixel ratio (DPR), so gaze and AOIs can be mapped in both
windowed and fullscreen mode without estimating browser toolbar heights.
Deploy the matching frontend and backend and install the rebuilt Windows
bridge from this release. The earlier bridge packages do not provide native
viewport measurements.

## Default: the guard observes and never blocks

Since app version `2026-11-18.1` the guard checks the display, shows the
settings and records them, but does not stop the participant. What follows in
this document about a dialog, a locked page or **Studienleitung: Fortsetzen**
applies only to a build with `VITE_LAB_DISPLAY_GUARD_BLOCKING=true`.

In the default build:

- Measured pages mount at once. Their questionnaire visit, CK deadline, video
  and screen recording start as they would without a guard, whatever the display.
- A display that is correct and unchanged for 500 ms verifies itself. There is
  no confirmation, neither initially nor after an interruption, in either
  profile. Losing verification (resize, zoom, scaling, focus, a second display,
  a stale or missing native measurement) is recovered the same way.
- Gaze is admitted for AOI mapping exactly as before: only while the display is
  verified. Everything else keeps its raw coordinates and exports as `unmapped`
  with `display_guard_interrupted` or `unverified_display`. The interruption and
  resume events, the per-layout `display_guard` record and the backend rules are
  unchanged, so exports and replay need no new handling.
- A setup that stays wrong produces one open interruption interval (the entry
  boundary, moved back once to the preceding observation), not a stream of events.
- Entering a measured page from the welcome page, SoSci, the think-aloud replay
  or the final page starts with an unverified display for the 500 ms stability
  window. Consecutive measured pages and the instruction pages between them keep
  their verification.
- **Mit aktueller Anzeige fortfahren** does not exist: there is nothing to waive.
- In-app calibration, where enabled, still refuses to run on an unverified display.

### Where the study lead sees the settings

The welcome page has one collapsed settings summary inside the welcome card.
It reports whether settings are ready, different, or still unverified. Clicking
or keyboard-activating the line expands a vertical list of only the different
or unverified settings, with the current and intended values below each heading.
It never opens itself after a measurement changes. Unknown values are not
reported as correct. With a bridge that measures the page, resolution, scaling
and fullscreen are layout notes; without one they decide whether gaze can be
mapped. **Vollbild öffnen** and **Bridge erneut verbinden** remain available
inside the expanded section.

Questionnaires, case introductions and video pages do not show persistent gaze,
AOI or display-status boxes, and case introductions do not repeat the setup
confirmation. Capture, retries, display verification and diagnostic events
continue in the background. Missing gaze is still recorded as a diagnostic
event when entering a case. Answer-saving failure messages remain visible.
See the [study-lead checklist](LAB_SETUP_CHECKLIST.md).

### Scrollbars

On Windows a scrollbar takes layout space, and the browser announces its
appearing or disappearing as a `visualViewport` resize without a window resize.
That is not a display change: a visual-viewport resize that leaves the inner
window size and the pinch scale as they were no longer revokes verification.
Before this, any page growing past the screen height (or shrinking back)
revoked it, which in the blocking build reopened the dialog on a correct setup.

## Run locally and deploy

Start the backend from this checkout with the usual local database/media
configuration. Point `frontend/.env.local` at it, then run:

```sh
cd frontend
npm run dev:lab
```

`VITE_LAB_DISPLAY_GUARD=true` also enables the guard. The
[LRZ deployment](../infrastructure/lrz/README.md) passes this build-time flag by
default. Generic Docker builds need `--build-arg VITE_LAB_DISPLAY_GUARD=true`.
Changing an environment variable on an already built web container does not
change the bundle: rebuild the web image. The backend must understand the
`native_viewport_v1` geometry and per-sample proof fields before the new bridge
is used. No database migration is required for these additional JSON fields.

On the lab PC, close the old bridge, unpack the new Windows package into its
own folder, and start its normal LRZ launcher. Refresh the study page to load
the matching frontend. Keep `CALIBRATION_ENABLED=false`; the bridge update does
not enable in-app calibration.

## Supported display setup

Use one physical monitor, the same monitor calibrated for the Tobii tracker
and used for screen recording. The native provider verifies that only one
monitor is active and that the study's content area lies entirely within it.
The researcher must still confirm the physical tracker/display pairing.

The reported lab monitor is 15.6 inches at 1920 × 1080. Fullscreen at 100%
Windows scaling and 100% Edge zoom remains the layout-regression baseline,
but it is no longer required for native coordinate mapping. Windowed,
maximized and fullscreen Edge are supported. Desktop browser zoom and Windows
scaling are supported when the physical content dimensions agree with the
reported CSS viewport and DPR. A smaller CSS viewport may need vertical scrolling. Questionnaire matrices
reflow into statement-by-statement choices when their container is too narrow
for readable columns; all options remain reachable without horizontal scrolling.
Question wording, option order and stored answer values remain unchanged.

Pinch zoom/panning, multiple monitors, content outside the calibrated display,
an ambiguous browser window, or a missing/stale native measurement are not
converted using guessed offsets. Keep the study tab in the foreground. The
existing guard intercepts Ctrl/Cmd plus/minus and Ctrl-wheel on measured pages;
zoom selected before entry or through browser controls is still measured.

## Participant behavior with the optional blocking build

This section describes `VITE_LAB_DISPLAY_GUARD_BLOCKING=true`, not the default
observing build described above. Persistent gaze-status badges are not shown
in either build.

- The first measured page waits for a fresh native measurement stable for
  500 ms and explicit **Studienleitung: Fortsetzen** confirmation. Until then,
  its questionnaire visit and timer do not start. Measured pages remain the
  in-app questionnaires, case videos, diagnosis pages and case outros with an
  assigned questionnaire.
- After this initial native confirmation, moving/resizing the window, changing
  zoom or fullscreen, or returning focus temporarily revokes verification.
  Fresh, stable native measurements automatically restore access after 500 ms;
  another operator confirmation is not needed. The draft stays mounted. A
  paused video does not restart automatically; its Play control becomes usable
  again. Recording is not restarted by a display change.
- Welcome, instruction pages, section/case introductions, phase transitions
  and outros without questionnaires stay usable while display settings are
  checked. SoSci, think-aloud replay and the final page are exempt from the
  display lock. SoSci opens normally in a separate tab. On returning to a
  measured page, native mapping is measured again and recovers automatically
  if this participant already completed the initial native confirmation.
- CK's server deadline always continues once started. A display interruption
  does not reset or pause it. Expiry saves the partial answer through the
  existing retry-safe finish-CK path and advances once; PCK becomes accessible
  after the native measurement is valid again. Case deadlines also continue.
- Active AOI mapping requires an admitted sample with a fresh native proof
  and a verified, visible DOM layout. A connected tracker, raw sample counts
  or a measured window alone are insufficient. Verify this in the recorded
  diagnostics and synthetic-run exports.
- **Mit aktueller Anzeige fortfahren** remains an explicit fallback for
  continuing without verified mapping. It retains answers and deadlines, but
  does not make uncertain gaze valid for AOIs. It lasts until reload/logout and
  never transfers to another participant. Choosing it disables automatic
  native re-verification for that continuation: reload and confirm normally
  before collecting verified AOI data again.

The confirmation is an operator acknowledgement, not an authenticated
supervisor login. In-app calibration remains disabled; calibrate and validate
externally in Tobii Pro Eye Tracker Manager. Approved study wording, MESP
option order and PCK/MESP page structure remain unchanged.

## Measurement and export behavior

The app requests native measurements every 125 ms through a session-scoped
bridge connection. A random tab marker identifies the foreground study
window without including participant identifiers. Correlated replies must
match the current tab, browser dimensions and DPR. A browser proof expires
after 500 ms. The bridge also reads native geometry at the SDK gaze callback,
so a sample carries its viewport generation and observation time rather than
inheriting the last window position seen by a browser timer.

Stored geometry uses `display_guard.profile=native_viewport_v1` and includes
physical display/content bounds, CSS viewport dimensions, DPR and the native
viewport identifier. Samples retain `viewport_id` and `viewport_ts`. Mapping
requires a matching generation, an observation within 50 ms of the sample,
and a verified DOM snapshot that existed at the sample time. Heartbeats do
not create duplicate layout snapshots. Browser resize/focus events and native
generation changes invalidate the preceding verification conservatively;
queued events can still correct an earlier interval.

For native data, the shared AOI/clip-replay transform is:

```text
physicalX = display.x + normalizedGazeX × display.w
viewportX = (physicalX - content.x) / dpr
```

The Y calculation is identical. DOM AOIs already use viewport CSS coordinates,
so ordinary document scrolling does not need another scroll subtraction.
`mapping_method=native_viewport` distinguishes this from historical
`window_estimate` data. Gaze on browser chrome or outside the content area is
`offscreen` with `mapping_reason=outside_viewport`; valid gaze inside the page
continues to map to AOIs.

Raw coordinates, timestamps, eye validity and pupil values are retained during
brief uncertain transitions. Those samples remain unmapped rather than being
assigned to the wrong AOI. Reasons include `display_guard_interrupted`,
`unverified_display`, `native_viewport_mismatch` and `stale_native_viewport`.
Recorded diagnostics retain this status. Durable interruption/resume
boundaries are scoped by participant and guard profile; an old open
`lab_1080p` interval does not suppress newly verified native data.

Screen and clip replay retain suppression intervals so a gaze dot is not held
or interpolated across an uncertain gap. Screen replay assumes the capture
covers the same single calibrated monitor. Raw recording files are not
rewritten, and historical records keep their original interpretation.

## Legacy fallback

If a bridge has never advertised native viewport support, the previous
`lab_1080p` profile remains available: one 1920 × 1080 display, 100% scaling and
zoom, fullscreen viewport/window at origin, and explicit confirmation after
interruptions. This is not the accurate windowed-mapping path. Install the new
Windows bridge for that path. Once native support has been advertised for the
current participant, a disconnect cannot silently downgrade to legacy
geometry; the native measurement must recover.

## Verification on the lab PC

### If the optional blocking display dialog cannot continue

Open the current study at `https://a04.rdm.lab.lrz.de/session` in Edge and refresh
with Ctrl+F5. The recovery dialog identifies app version `2026-11-17.2` and later
under **Technischer Status**. A tab inside a running session keeps the JavaScript
it loaded and is never reloaded for a release. A tab waiting on the participant
login page reloads itself instead (see the [study-lead checklist](LAB_SETUP_CHECKLIST.md)).

The dialog now distinguishes an unreachable bridge, an older bridge and a native
measurement failure. **Aktuelle Windows-Bridge herunterladen** downloads the
verified Windows package directly from the study website. Extract the entire ZIP,
close the old bridge, start the extracted `A04Bridge.exe`, and leave it running.
Then select **Bridge erneut verbinden**. This starts an explicit loopback
permission request before opening a fresh bridge connection; it does not reset
the participant, answers or existing deadlines. The permission stage allows up
to 90 seconds for the browser prompt. Only the subsequent WebSocket handshake
and a matching native measurement establish connection and geometry readiness.

If permission is denied, use Edge's permissions for this exact study origin to
allow **Apps auf dem Gerät** / **Loopback-Netzwerk**. Older Edge versions may show
a combined **Lokales Netzwerk** permission. The app displays denial guidance
when the granular Permissions API is available; otherwise it gives generic
connection instructions. It never changes browser permissions on the user's
behalf. The CSP permits HTTP permission checks only at the configured localhost
bridge port, alongside the existing WebSocket connection.

If recovery still fails, expand **Technischer Status** and use **Diagnose
kopieren**. The text identifies the loaded bundle, connection, permission and
geometry status without participant IDs, answers, window titles or tab nonces.
Distinct connection states are also logged, with a per-session limit, before the
blocked questionnaire mounts. This separates a local connection failure from
server availability and a native mapping error.

The optional blocking build requires **Studienleitung: Fortsetzen**; the
default build verifies automatically. In both builds, verify actual AOI
collection in a synthetic run. Unverified continuation does not repair missing gaze.

### Fixation and session checks

1. Close the old bridge and start the new package. Run
   `Check-eye-tracker.cmd` with the normal bridge closed first, then restart the
   bridge. Verify the real Fusion, 120 Hz and valid gaze samples. Calibrate and
   validate externally on the intended single monitor.
2. Start a synthetic participant in an ordinary Edge window. Confirm the
   welcome settings, then check raw reception and active AOI mapping in
   the recorded diagnostics and exports. Look at known targets on the video, code,
   instructions, response controls and a popup. Compare the replay and exported
   AOIs with those targets; check `mapping_method=native_viewport`.
3. Move and resize the window, maximize it, enter/leave fullscreen and test the
   intended browser zoom. Confirm drafts remain, the display measurement
   recovers automatically and stable gaze maps correctly in each mode. Only
   transition/invalid samples should remain unmapped. Recheck the physical
   fixation targets after each change.
4. Open and return from SoSci. During a separate short synthetic CK test, keep
   the display interrupted across expiry and confirm the partial answer saves
   once, the deadline is unchanged and PCK becomes accessible after recovery.
5. Test a missing bridge or unverified continuation separately. Confirm the
   recorded diagnostics and exports do not claim active AOI mapping merely
   because raw gaze arrives. Reload and check the welcome settings before
   the actual data-collection run.

Automated tests check transformations and data integrity with synthetic gaze.
The Windows build also compares native measurements with actual Edge pointer
coordinates driven by the OS cursor. These checks do not measure Tobii
calibration accuracy, participant positioning or device latency; physical
fixation validation on the lab PC remains necessary.

## Automated checks

```sh
cd frontend
npm run typecheck
npm run lint
npm test
npm run test:browser
npx playwright test --config playwright.guard.config.ts
npx playwright test --config playwright.display-check.config.ts
```

The first Playwright suite builds with the blocking flag and covers the dialog;
the second covers the observing default (tests tagged `@observe`). Set
`A04_GUARD_PORT` / `A04_DISPLAY_CHECK_PORT` if ports 5194 / 5195 are taken.

The guard suite covers both legacy behavior and native windowed/fullscreen
mapping, zoom, resize recovery, stale/mismatched proofs, CK and SoSci. Backend
regressions cover CSV/replay mapping, profile isolation, delayed events and
legacy compatibility. The Windows bridge workflow runs
`test_native_viewport_windows.py` before packaging, using Edge and physical
cursor positions; its artifact manifest records the checks and explicitly
states that the eye-tracker hardware was not tested by CI.
