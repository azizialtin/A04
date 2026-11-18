# Running A04

What to have in place before the first participant sits down, and what to do
when something goes wrong during a session.

## What has to be backed up

Two things, and they only make sense together:

- **Postgres** — participants, sequences, notes, diagnoses, questionnaire
  responses, the interaction log, gaze recording headers, calibrations, audit.
- **The uploads** — case clips, the gaze chunk files and the screen recordings.
  These live in the bucket in production, and in `backend/uploads/` (a named
  volume under compose) otherwise. Budget for the screen recordings: about
  1–1.5 GB per participant.

Restoring the database alone leaves rows pointing at recordings that are gone.

### Local or lab machine

```bash
scripts/backup.sh                 # writes ./backups
scripts/backup.sh /Volumes/lab    # or wherever
# Explicit source when needed:
BACKUP_MEDIA_MODE=compose scripts/backup.sh /Volumes/lab
BACKUP_MEDIA_MODE=local UPLOADS_DIR=/path/to/uploads scripts/backup.sh /Volumes/lab
```

Run it after each participant. It writes a `pg_dump` custom-format file and a
tarball of the uploads, both stamped with the UTC time.

The default detects an existing Compose backend container and reads its actual
mounted uploads volume, even if the container is stopped. An explicit
UPLOADS_DIR selects local files instead. Missing media directories or mounts
fail the backup; they are never silently skipped. The database and archive are
published together only after both commands succeed and the archive can be read.
Docker is required for Compose media; pg_dump must be installed on the host.
This script handles local/Compose storage; use the cloud procedure for GCS.

Pause new sittings and let pending writes/uploads finish before taking the pair.
The database dump and media archive are not one atomic filesystem snapshot.
After restoring into an isolated environment, open a stimulus and screen
recording and export a complete gaze recording to verify the media as well as
database rows. A successful list-admins command alone does not establish that.

### Cloud SQL and Cloud Storage

```bash
# Nightly automated backups, kept a month, with point-in-time recovery.
gcloud sql instances patch a04-db \
  --backup-start-time=02:00 \
  --retained-backups-count=30 \
  --enable-point-in-time-recovery \
  --retained-transaction-log-days=7

# Versioning on the media bucket, so a delete is recoverable.
gsutil versioning set on gs://a04-media
```

## Restoring

Test this **before** you need it, on a scratch database. A backup nobody has
restored is a guess.

```bash
# 1. Database
createdb a04_restore
pg_restore --dbname=postgresql://a04:a04@localhost:5434/a04_restore \
           --no-owner --clean --if-exists backups/a04-<stamp>.dump

# 2. Uploads
tar --extract --gzip --file backups/uploads-<stamp>.tar.gz -C /tmp/restore

# 3. Check the two agree: every recording's chunks should be on disk.
cd backend && DATABASE_URL=postgresql+asyncpg://a04:a04@localhost:5434/a04_restore \
  python -m app.cli list-admins   # smoke test that the schema is intact
```

Cloud SQL restores are `gcloud sql backups restore <id> --restore-instance=…`;
restore to a *new* instance first and compare row counts before switching over.

## Retention and erasure

The data is pseudonymous — a participant id, never a name — but gaze is
biometric and the screen recordings capture the lab machine's whole display for
the length of each case, so treat the whole set as personal data under GDPR. Have
nothing else open on that display during a session.

- **Retention.** Agree a period with the ethics board and write it down here
  once decided. Nothing expires automatically; deletion is deliberate.
- **Erasure.** `DELETE /admin/participants/{id}` removes the participant row,
  everything cascading from it (notes, diagnoses, responses, events, gaze
  headers, calibrations, sequence, session) *and* their gaze chunk files and
  screen recordings. It does not touch the SoSciSurvey side — those rows are keyed by the same
  participant id and have to be deleted there too.
- **Backups.** An erasure is not complete until the backups containing that
  participant have aged out. Note the date; do not restore an old backup over a
  database from which someone has been erased.
- **Exports.** CSVs downloaded to a laptop are outside all of this. Keep them on
  encrypted storage and delete them when the analysis is done.

## Monitoring

- **Liveness / readiness.** `GET /health/live` and `GET /health/ready`; the
  second checks Postgres is reachable. Point an uptime check at `/health/ready`
  and alert on two consecutive failures.

  ```bash
  gcloud monitoring uptime create a04-ready \
    --resource-type=uptime-url --host=api.example.org --path=/health/ready
  ```

- **Errors.** Unhandled exceptions are logged as JSON at `severity: ERROR` with
  the traceback in the message and the request id alongside, which is the shape
  Cloud Error Reporting groups on — so it works with no extra dependency. If
  you would rather use Sentry, add `sentry-sdk[fastapi]` and initialise it in
  `main.py`; nothing else has to change.

- **Finding one request.** Every response carries `X-Request-ID`, and a 500
  puts the same value in the body. A participant can read it out, and

  ```
  jsonPayload.request_id="<the id>"
  ```

  finds every log line for that request.

- **Front end.** A crash in the UI is posted to the interaction log as a
  `ui_error` event, so it shows up in the events export rather than only in a
  console nobody was watching.

## Rolling a deployment back

The gaze screen-context change requires migration `c8e2f4a6b9d1`, after the MSK
migration `b3d8f2a6c4e1`, before the updated backend is deployed. It permits a
recording without a video and adds screen kind, step index and questionnaire id.
Existing rows become `case_video`; their samples and geometry are untouched.
This repository update does not itself apply the migration to production.

`alembic downgrade` is a development tool, not a rollback plan. Every migration
that added a column drops it on the way down, and some of those columns are
unrepeatable research data — which video set a participant was dealt, whether a
recording came from the bridge or the browser, the wording a researcher wrote.
The CK-table migration additionally folds two question pages back into one.

To undo a deployment in production, restore the database from a backup (see
above) and deploy the previous image. Downgrade only against a database you are
willing to lose.

## Gaze data and analysis

Participant progress reaches 100% when the participant or session is completed,
including runs whose saved pointer is on the final thank-you screen. The saved
zero-based pointer remains unchanged.

Case, participant and study gaze statistics count only `case_video` recordings.
The displayed Erfassungsquote
is an estimate of sample delivery, not eye validity or calibration accuracy.
Its denominator sums each completed recording's server-clock duration multiplied
by that recording's nominal sampling rate, so resumed attempts, gaps and mixed
rates are handled separately. Upload delays can lower this estimate. Open or
inconsistent recordings (including impossible sample counts) show no percentage;
they are never silently clamped to 100%. Historical records without usable timing
also show no percentage. Stored historical data is not deleted.

`gaze.csv` is one row per stored video-screen sample, including invalid samples. It preserves
`ts`, `device_ts`, left/right coordinates, validity and pupil diameters. It also
includes participant/recording ids, case columns where applicable, `step_kind`,
`step_index` and `questionnaire_id`. The metadata formerly exported as
`gaze.csv` is now `gaze_recordings.csv`. A short metadata file is not evidence
that only that many gaze samples were captured.

New recordings cover only the `case_video` screen, including pauses, notes and
popups. Navigation stops its gaze subscription synchronously; the remaining
video samples may finish uploading after navigation. Questionnaires, diagnosis,
case introductions/outros and think-aloud do not collect research gaze samples
or layout coordinates. The pre-case tracker check requests connection status
only; sample reception/validity is checked once the video screen starts.
Optional calibration retains its separate validation measurements and export.
The pilot's display checks still protect questionnaires, diagnosis and assigned
outro questionnaires independently of gaze collection; they do not start gaze
recordings on those screens.
The API rejects non-video recording starts and new samples/layouts for old
non-video recordings. Gaze tables, CSVs and their counts exclude those historical
non-video recordings, while their database rows and raw files remain intact.
Deploy the frontend and backend together; older cached clients attempting
non-video capture will receive HTTP 422. This restriction needs no new database
migration. SoSci remains outside the capture scope.

The export reads raw NDJSON from each recording's own local/GCS storage mode;
it does not use the replay's reduced point set. Rows retain native samples,
including adjacent timestamps; there is no 100 ms resampling. They are grouped
by participant and recording start, then stored sample order. Join or sort
`ts` with event `client_ts` for a combined wall-clock timeline. The export tab
counts committed sample counters. For a recording still in progress, the
download uses the committed count it read and ignores subsequently appended
chunks. Export after capture completes when a complete sitting is needed.

New clients attach the confirmed sample offset to each upload and retain the
exact batch while retrying. Under a recording row lock, the server accepts an
identical retry of a committed chunk without counting it again; a conflicting
payload or future offset is rejected. This protects against a lost HTTP
acknowledgement. Older clients without offsets keep their existing append
behavior; exports preserve historical rows rather than silently deduplicating
them by timestamp.

Downloads check storage before sending data and validate chunks and sample
counts while streaming. Missing storage returns an error; a corrupt or missing
later chunk aborts the stream. The admin shows a failed download and does not
save a partial CSV. Check the server log and the recording's storage location,
then retry; do not treat an interrupted transfer as a smaller valid dataset.
The backend holds one recording and small CSV buffers, rather than staging a
whole study in `/tmp` (which can consume instance memory on Cloud Run).

AOI rectangles are captured from the viewport when layout, scroll or visible
dialogs change. Raw `geometry_ts` references the observed layout; `layout_ts`
is the layout actually resolved during export. Missing references, unavailable
layouts, conflicting snapshots at the same timestamp and hidden pages are
`unmapped`. Historical samples without a layout reference remain unmapped even
if screen geometry exists; no historical AOI labels are reconstructed. Invalid
eyes are retained in the raw columns but excluded from the derived binocular
mean; both invalid/unknown eyes produce `invalid`. A valid point outside the
display/viewport is `offscreen`; a visible known layout with no matching area
is `other`; a hit has the stable AOI id and `aoi_status=matched`.
Clock rollback detection checks both layout measurements and sample receipt
times against the highest browser clock reading seen during the video. An
observed rollback of more than 100 ms keeps subsequent raw samples but disables
AOI attribution for the rest of that recording; `gaze_capture_status` events
carry `clock_uncertain: true`. The 100 ms threshold is a recovery policy, not
evidence of what caused a clock adjustment.

For smaller detected rollbacks, samples remain raw/unmapped until a fresh DOM
measurement is later than the pre-rollback high-water mark plus 100 ms, and
later than every bridge timestamp received within that guard window. This
guard accounts for the browser and bridge clocks adjusting independently. The
new measurement is saved even when the layout is unchanged. Samples received
after recovery map only if their timestamps are strictly newer than that
measurement plus another 100 ms guard for bridge clock lead. Bridge frames
received after the first guard window do not keep moving the recovery boundary;
otherwise a slightly faster bridge clock could prevent recovery indefinitely.
The uncertainty cutoff is retained and can only advance: older
delayed samples stay unmapped even after recovery or another rollback. This
conservatively includes delayed samples preceding the first rollback observation.

Each recording's closing `gaze_capture_status` event (`state:
capture_finished`, in the `payload` column of `events.csv`) carries
`clock_rollbacks`: how many times a clock reading, taken at a layout
measurement or a sample receipt, was lower than the reading before it. A step
back counts once; the readings that follow while the clock catches up do not.
With `clock_uncertain: false`, every counted rollback was recovered from as
described above, and each leaves samples `unmapped` for about 0.2–1.3 s after
the step while the page is visible: the two 100 ms guards plus the wait for the
next layout measurement, which is taken at least once a second. A rollback that
falls entirely between two readings cannot be observed and is not counted. The
count shows how often a given machine's clock steps back during capture.

Near video entry, a small rollback can make genuine video samples appear older
than entry. The accepted timestamp boundary is lowered to the pre-rollback
high-water mark minus 100 ms only when that extends before entry. Samples in
this overlap are retained without AOIs, including delayed arrivals; clearly
older frames are still rejected. Wall-clock timestamps alone cannot distinguish
stale frames from genuine video samples within the overlap. Without a detected
rollback, the normal entry boundary is unchanged. Collection remains limited
to the active video subscription.

The video picture has two AOIs: `video_students` is its left half and
`video_code` its right half. The boundary is exactly the midpoint of the
rendered picture (`object-fit: contain`), before viewport/scroll clipping;
letterbox/pillarbox bars belong to neither half. The boundary itself belongs
to `video_code` (half-open rectangles), so a sample never belongs to both.
Until video metadata supplies the actual frame size, no video AOI is assigned.
The controls underneath retain their own AOIs. Historical single-`video` AOIs
are preserved as captured; the export does not relabel old data.

The three rail buttons have at least 24 CSS pixels of space between them and
a 6-pixel AOI margin, leaving at least 12 pixels unassigned between neighboring
button AOIs. Margins are clipped at scroll-container and viewport boundaries.
`task_button` opens **Aufgabenstellung**, `info_button` opens **Diagnose
Definition**, and `student_task_button` opens the student task/code. The
instruction popup uses the standard participant guidance; the researcher’s
case-specific task wording remains on the diagnosis screen.

Each text popup has a container AOI (`task_dialog`, `info_dialog`,
`student_task_dialog`), a higher-priority text-body AOI (suffix `_text`) and a
separate close-button AOI (suffix `_close`). Only the active modal and any
notifications actually painted above it are eligible; gaze on its backdrop is
`other`, never attributed to the video underneath. Scrolled-away text is
excluded from the visible body rectangle.

The interaction log includes `task_opened`/`task_closed`,
`info_opened`/`info_closed` and `student_task_opened`/`student_task_closed`.
Close payloads contain `durationMs` (monotonic elapsed open time) and `reason`;
normal dismissals, screen exits, failed progression and ordinary page exits
close the interval. Automatic closures remain exposure events but do not receive
a codebook click-variable label. Events use the durable interaction outbox. An abrupt browser
or machine crash can still leave an unmatched open event: treat that duration
as unknown. Open time includes periods without gaze or with the browser hidden;
it measures availability of the text, not reading. Use valid samples assigned
to the `_text` AOI for gaze-based attention analysis and specify the fixation/
dwell estimator and treatment of missing samples separately.

Each recording accepts up to 10,000 layout snapshots. After that limit, the
client keeps collecting gaze with `geometry_ts=null`, so those samples remain
unmapped. If an additional layout reaches the backend, it preserves the earlier
snapshots and appends one terminal unavailable-layout marker. The layout limit
does not cap the number of raw gaze samples exported.

`screen_x`/`screen_y` are normalized display coordinates. For the new native
Windows path, `screen_px`/`screen_py` are physical desktop pixels and
`viewport_x`/`viewport_y` are CSS pixels. `mapping_method=native_viewport`
identifies the transform: subtract the measured physical browser-content
origin from the physical gaze point, then divide by the recorded DPR. Browser
chrome is not estimated. The sample's `viewport_id` must match its recorded
native geometry, and `viewport_ts` must be within 50 ms of its gaze timestamp.
A visible, verified DOM layout must also exist at the sample time.

Historical `mapping_method=window_estimate` rows retain their earlier
browser-reported screen units and outer/inner-window calculation. Do not mix
the screen-pixel units of these two mapping methods without conversion.
Missing display information does not certify mapping. Native mapping supports
windowed/fullscreen mode, desktop browser zoom and Windows scaling when the
physical bounds agree with the CSS viewport and DPR. Pinch zoom/pan, multiple
monitors, ambiguous/stale native bounds or content outside the calibrated
monitor remain unsupported. Gaze on browser chrome is `offscreen` with
`mapping_reason=outside_viewport`, rather than a hit on page content.

Visible notification cards and unsent-write notices take precedence over the
content they cover; a modal excludes notices painted behind its backdrop.
Browser DOM observations are coalesced to animation frames. The native bridge
also measures at the SDK callback and tags every sample with the relevant
viewport generation. Resize/focus/generation transitions temporarily revoke
verification; uncertain samples retain their raw values but do not receive
guessed AOIs or replay dots. Durable interruption intervals are scoped by guard
profile, so earlier `lab_1080p` interruptions do not invalidate newly verified
`native_viewport_v1` geometry. Device-to-callback latency remains unmeasured.

An AOI debug overlay verifies DOM rectangles and modal precedence. It does
**not** calibrate the tracker or establish physical gaze accuracy. Validate
with the lab's tracker and calibrated display before interpreting small areas.
AOI hits are sample labels, not fixations or dwell-time measurements.

### Fusion lab display

The reported lab setup is a Tobii Pro Fusion at 120 Hz, Windows, Edge, and a
15.6-inch 1920×1080 display with Windows scaling at 100%. Install the rebuilt
Windows bridge from the native-viewport release; earlier packages cannot
provide the physical browser-content measurements required for accurate
windowed AOI mapping. Use one physical monitor for the tracker, browser and
screen recording. Close the old bridge before starting the new package, and
refresh the app to load the matching frontend/backend release.

The layout-regression baseline remains a **1920×1080 CSS viewport** at 100%
zoom, but native mapping works in an ordinary window, maximized or fullscreen.
Desktop zoom/scaling are measured through physical content bounds and DPR;
a smaller CSS viewport can require scrolling without changing authored option
order. Edge's `Ctrl+0` reset and `F11` fullscreen shortcuts are documented by
[Microsoft](https://support.microsoft.com/en-us/edge/keyboard-shortcuts-in-microsoft-edge).
Pinch zoom and multiple displays remain unsupported.

Calibrate and validate in Eye Tracker Manager before a sitting. In-app
calibration stays disabled (`CALIBRATION_ENABLED=false`). Run
`Check-eye-tracker.cmd` with the normal bridge closed, then start it again.
Check that the real device reports Fusion, 120 Hz and valid samples; a
successful connection alone is insufficient. The bridge reads the device's
configured frequency and physical display area. The monitor diagonal is not a
substitute for that measured/configured area. Tobii lists 120 Hz support and a
50–80 cm operating distance for
[Fusion](https://www.tobii.com/products/eye-trackers/screen-based/tobii-pro-fusion).

Before collecting research data, make a short test recording on that PC in
both windowed and fullscreen mode. Confirm the initial display measurement,
then require **AOI-Zuordnung aktiv.** as well as raw gaze reception. That status
requires an admitted sample with a matching native proof and verified DOM
layout; raw sample counts alone are not enough. Look at known targets in the
video, instructions, answer controls and a popup, then compare the recording,
replay and AOI export against those targets. Repeat after moving/resizing the
window and changing the intended zoom. Subsequent valid measurements recover
automatically; brief transition samples remain unmapped. Software and Windows
cursor tests verify the mapping path but cannot measure participant calibration
accuracy, physical alignment or device latency. See
[lab display guard](LAB_DISPLAY_GUARD.md) for the complete acceptance checklist.

## During a session

- **Display measurement after moving or resizing the window.** The first native
  measurement needs researcher confirmation. Later display changes briefly
  block measured pages while fresh geometry stabilizes, then restore access
  automatically. Drafts stay mounted; video remains paused until Play is
  pressed. CK and case deadlines continue, and CK expiry still saves once and
  moves to PCK. SoSci is exempt; returning to the study remeasures the native
  viewport without another confirmation after the initial native setup.
- **Raw gaze arrives but AOI mapping is waiting.** Check the updated Windows
  bridge, foreground study tab and single calibrated display. A bridge
  disconnect cannot silently downgrade a native session to estimated geometry.
  **Mit aktueller Anzeige fortfahren** permits unverified continuation but does
  not certify those samples for AOIs. Reload and confirm the measured setup
  before collecting verified gaze/AOI data again.

- **Navigation after a connectivity warning.** Requests still try the lab API
  even when Windows reports no Internet connection. Actual request failures
  show the existing session error message and keep the current page for retry.
  The client does not advance without the server's acknowledgement.

- **Weiter on the case screen** opens **Fall abschließen?**. **Beim Fall bleiben**,
  Escape, or closing the dialog keeps the participant on the case with their notes.
  **Zur Diagnose** confirms the move. Playback, the case timer and any active
  screen/gaze capture keep running while the dialog is open; opening it does not
  pause, restart or upload a recording. A configured case time limit still ends
  the case automatically. If navigation fails, the dialog offers a retry without
  discarding notes. This is separate from the CK section timer below.
- **A red banner at the bottom of the participant's screen** means writes are
  not reaching the server. The data is queued locally and will go up when the
  connection returns — do not close the tab or log out, which discards drafts.
- **The gaze dot is missing on the think-aloud screen.** Check the bridge is
  running and the tracker was calibrated externally, or check the recorded
  accuracy if in-app calibration was enabled. The admin replay viewer says
  explicitly when a recording has no screen geometry.
- **The think-aloud shows the clip instead of the screen recording.** A usable
  screen recording was not available when replay loaded. Capture may have
  failed, its upload may still be pending, or its playback URL may be unavailable.
  While an upload is pending, the page says so and checks again automatically
  for up to 60 seconds before selecting the available replay. Once playback is
  exposed, its source stays fixed; a late upload does not switch it mid-review.
  Check the Bildschirm column in the admin's gaze list and server logs. Missing
  ffmpeg on the lab machine's PATH is one possible cause, reported by the bridge
  at startup. When bridge capture is unavailable, the page can record the display
  if the participant grants whole-screen sharing on the case intro. A bridge
  failure enables that browser fallback on the next case. A cancelled picker
  is not asked again until the page is reloaded. Such a capture shows as
  "Browser" in that column. The session remains usable with the clip and gaze
  when screen capture is unavailable.
- **A participant's Set column says "wird zugelost".** They have not logged in
  yet; the set is dealt at first login so the halves are counted over the
  people who turn up. To fix a set in advance, use "Set zuweisen" in their
  sequence editor.
- **A row stuck at "läuft…" in that column** is a capture whose upload never
  arrived. Look in `tobii-service/unsent-recordings/` on the lab machine: a file
  the backend would not take is kept there rather than deleted.
  Browser captures send a heartbeat every 30 seconds until delivery finishes.
  Closing the page reports the interruption; if the tab crashes, the next
  recording-list or replay request marks it failed after three minutes without
  a heartbeat. Stored captures and bridge captures are not expired this way.
  A valid late upload can still recover an interrupted capture.
- **A participant cannot log in.** After too many attempts the login is refused
  for a minute — wait, then check the id in the admin.
  Completed participants see a thank-you message explaining that the study has
  already been completed; they cannot start a second run with the same ID.

## Between two participants

The closing screen has **"Mit der nächsten Person beginnen"**: it ends the
session and goes back to the id prompt, which is the only thing that needs
doing between two sittings. It also clears the finished run out of the browser —
drafts and cached session — so the next person cannot be shown the previous
one's script.

The button waits while the red banner is up. Those writes are queued under the
participant who has just left and only go up while they are signed in, so
hand over once the banner is gone. If it will not clear, fix the connection
before starting the next sitting.

## Stepping a run back

The participant has no back button. The person supervising the run can press
**Ctrl+Alt+Shift+B** (Cmd+Alt+Shift+B on a Mac) on the participant's screen;
a dialog names the current screen and the one before it and asks to confirm.
One press is one screen. Nothing is deleted: a page answered again overwrites
its answers and opens with the stored ones, a video watched again is recorded
again (the replay shows the newest recording), and the move is logged as an
`admin_step_back` event naming both screens, so the data shows where a run
doubled back.

## Questionnaire sections and introductions

In a study's **Fragebögen** tab, the section overview identifies the instruments
used in the data-collection document:

| Instrument in the document | Stored section function |
| --- | --- |
| Demographics/participants | `demographics` |
| `ck_pre_self` (programming/debugging self-assessment) | `ck_self` |
| `ck_pre` (debugging tasks) | `ck_tasks` |
| `pck_pre` | `pck` |
| `mesp_pre` (November 16 pilot) | `mesp` |
| `msk_pre` (historical instruments) | `msk` |

These are display mappings, not changes to stored question IDs or export values.
The overview shows populated pages and whether an introduction is configured.
Its edit action opens the existing page editor at the first populated page of
the section. Use **Abschnitt und Einleitungsseite** to set its heading and text.
An empty draft page is skipped by the participant flow, so an introduction there
does not create an introduction screen. Introductory text on a later page also
does not replace the first page's introduction; the overview flags that mismatch.

Adding or removing an introduction changes the session sequence and is refused
once sessions exist. Editing the wording of an already configured introduction
is allowed. Use a new study for structural changes to a started study; do not
alter stored participant progress. The diagnosis and post-case questionnaires
each have one shared definition, administered after **every case**.

New studies use the November 16 pilot instrument: the revised thirteen CK
tasks, a PCK introduction and three PCK pages containing ten conceptual items,
then the full MESP introduction and six pages. The MESP strategy order is fixed.
The October and 2 November instruments remain available for historical studies;
their single PCK example and MSK content are not upgraded in place. See the
[pilot protocol](pilot-20261116.md) for the source documents, approved wording,
scales and exact page order.

## Timed CK pre-test

Apply `alembic upgrade head` before serving the matching backend. Migration
`d9f1a3b5c7e2` introduced section attempts and questionnaire visits;
`f8b1c3d5e7a9` added the versioned pilot flow. Existing studies retain their
legacy protocol and questionnaire content.

New studies include two CK self-assessment pages, the approved CK introduction
and thirteen debugging tasks, followed by the PCK and MESP introductions and
pages described above. CK tasks use section function `ck_tasks`, followed by
PCK with function `pck`. The section name is a display/export label; it does
not activate the timer. Put any editable section introduction on its first
populated page only. Empty draft pages remain hidden.
Structural edits are refused once a participant has logged into the study;
prepare a new study for changes to questions, order, options or code.

The seven-minute timer starts when the first CK task opens, excluding the
introduction. Reload and supervisor back do not restart it. In the November 16
pilot, expiry automatically saves the current partial answer, closes its visit
and the CK attempt, shows a short notice, and opens the PCK introduction or first
page. The server checks the deadline before accepting `timer_expired`; an early
request cannot finish the section. Legacy studies keep the earlier behavior:
at zero the page shows a notice and does not advance automatically. A normal
valid submission or the supervisor shortcut can still advance it.

In both protocols the supervisor can press **Ctrl+Alt+Shift+N**
(Cmd+Alt+Shift+N on a Mac) from a CK task and confirm **Speichern und zu PCK**.
This also saves the current partial answer and actual exit time before opening
PCK. Unvisited tasks receive no answer or timestamps. The shortcut has no effect
outside CK. Like the back shortcut, it uses the participant session and is a
supervisor convention, not a separate administrator authentication check.

If saving fails, keep the tab open and retry using the displayed controls;
do not bypass the save by navigating away. Drafts are local to the participant.
A finished section retains its original timing when reviewed; subsequent visits
are marked as review. Actual elapsed time can exceed seven minutes when saving
is delayed or the supervisor intervenes late; the export records that overrun.

`responses.csv` stores a CK answer as an object under the question ID, with
`lines` (at most five numbers) and `explanation` (text). The pilot's explicit skip
stores `{"lines":[0],"explanation":"","skipped":true}` and
`response_status=skipped`. An empty answer is not automatically a skip. A timer
expiry or supervisor exit may leave either component absent or incomplete;
`response_status=partial` distinguishes it from a normal submission. PCK rankings
are ordered arrays of the configured option values. Multiple-answer checkbox
questions use `multi_select` and export an array of the selected option values, preserving
their number/string types. Existing `multiple_choice` questions remain
single-choice and export one value. Neither answer keys nor automatic scores are
sent to participants.

`sections.csv` retains its existing response totals and adds the section key,
original start/end/deadline, elapsed/overrun, visited-page count and `page_visits`
JSON. Visits contain entry/exit times, exit reason, review flag and the answers
at submission; reloads can create multiple visits to the same page. An abandoned
visit without an observed exit remains open rather than receiving an invented
exit time. Timing is available even before an answer is submitted, including
PCK pages that were visited but not submitted. Historical
responses without these records retain blank timing fields. Filter out review
visits when analysing the original timed attempt.

The versioned source snapshots, ID crosswalk and safe import command are documented
in [`backend/app/data/README.md`](../backend/app/data/README.md). The 2 November
snapshot corrected CK IDs without changing exercise order; the November 16 pilot
reorders and revises exercises. Never combine exports by question ID alone across
these versions; use the documented exercise crosswalk. Pilot MESP uses
`mesp_pre_*` IDs and section `MESP`; historical `msk_pre_*` answers retain their
original meaning. CSV filenames remain `responses.csv` and `sections.csv`.

In the admin's participant statistics, **Abschnittszeiten** shows actual section
start/end, elapsed time, CK overrun and the original visited-page count.
Expand **Seitenbesuche** for review flags, missing exits and saved answer snapshots.
**Summierte Antwortzeiten** remains the sum of the latest saved page responses,
including partial answers; it is not the original uninterrupted section duration.
In **Videos**, each existing clip's **Bearbeiten** action updates its title,
task/info/student text, default-text links and timer without re-uploading media.

Existing studies keep their protocol and instruments. Migration `f8b1c3d5e7a9`
updates only four exact stock case-outro strings in studies without sessions or
responses; custom wording is preserved. Migration `a1d3f5b7c9e2` freezes existing
started video sequences without changing their current order or saved position.
The standard-battery seed action skips a pre-test placement that already has
pages. Use a new study for a new instrument version, or preview the guarded CK
import for a selected unstarted study whose populated PCK page already follows
self-assessment. The command uses the current version's mapping unless an explicit
override is supplied, previews changes by default, and refuses studies with
started sessions or responses. A local draft and local tests do not deploy
the instrument to a live environment.
