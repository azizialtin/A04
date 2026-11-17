# Lab display guard and native viewport mapping

The current Windows bridge measures the study page's content rectangle in
physical desktop pixels. The app combines that rectangle with the browser's
CSS layout and device-pixel ratio (DPR), so gaze and AOIs can be mapped in both
windowed and fullscreen mode without estimating browser toolbar heights.
Deploy the matching frontend and backend and install the rebuilt Windows
bridge from this release. The earlier bridge packages do not provide native
viewport measurements.

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
reported CSS viewport and DPR. A smaller CSS viewport may need scrolling;
this does not change the authored page layout or option order.

Pinch zoom/panning, multiple monitors, content outside the calibrated display,
an ambiguous browser window, or a missing/stale native measurement are not
converted using guessed offsets. Keep the study tab in the foreground. The
existing guard intercepts Ctrl/Cmd plus/minus and Ctrl-wheel on measured pages;
zoom selected before entry or through browser controls is still measured.

## Participant behavior

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
- The gaze badge distinguishes raw eye-coordinate reception from
  **AOI-Zuordnung aktiv.** The latter requires an admitted sample with a fresh
  native proof and a verified, visible DOM layout. A connected tracker, raw
  sample counts or a measured window alone are insufficient.
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
The mapping-waiting badge makes this visible. Durable interruption/resume
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

1. Close the old bridge and start the new package. Run
   `Check-eye-tracker.cmd` with the normal bridge closed first, then restart the
   bridge. Verify the real Fusion, 120 Hz and valid gaze samples. Calibrate and
   validate externally on the intended single monitor.
2. Start a synthetic participant in an ordinary Edge window. Confirm the
   initial measured display, then check both raw reception and
   **AOI-Zuordnung aktiv.** Look at known targets on the video, code,
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
   badge does not claim active AOI mapping merely because raw gaze arrives.
   Reload and confirm the measured setup before the actual data-collection run.

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
```

The guard suite covers both legacy behavior and native windowed/fullscreen
mapping, zoom, resize recovery, stale/mismatched proofs, CK and SoSci. Backend
regressions cover CSV/replay mapping, profile isolation, delayed events and
legacy compatibility. The Windows bridge workflow runs
`test_native_viewport_windows.py` before packaging, using Edge and physical
cursor positions; its artifact manifest records the checks and explicitly
states that the eye-tracker hardware was not tested by CI.
