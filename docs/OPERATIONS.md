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

`gaze.csv` is one row per stored sample, including invalid samples. It preserves
`ts`, `device_ts`, left/right coordinates, validity and pupil diameters. It also
includes participant/recording ids, case columns where applicable, `step_kind`,
`step_index` and `questionnaire_id`. The metadata formerly exported as
`gaze.csv` is now `gaze_recordings.csv`. A short metadata file is not evidence
that only that many gaze samples were captured.

New recordings cover the main case screen, standalone in-app questionnaire
pages, diagnosis and case-outro screens. Standalone pages have no `video_id`.
They appear in the admin recordings list, but only case recordings have the
case replay. SoSci runs in another tab and is outside this capture scope.

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

Each recording accepts up to 10,000 layout snapshots. After that limit, the
client keeps collecting gaze with `geometry_ts=null`, so those samples remain
unmapped. If an additional layout reaches the backend, it preserves the earlier
snapshots and appends one terminal unavailable-layout marker. The layout limit
does not cap the number of raw gaze samples exported.

`screen_x`/`screen_y` are normalized display coordinates. `screen_px`/`screen_py`
and `viewport_x`/`viewport_y` use CSS pixels and the recorded browser window
dimensions; `mapping_method=window_estimate` identifies this derivation.
New recordings also retain visual viewport scale/offsets and, where the
browser exposes it, whether multiple displays are connected. Known unsupported
zoom/pan, multiple displays, and a window wholly outside the assumed display
produce `unmapped` with `mapping_reason=unsupported_visual_viewport`,
`multiple_displays`, or `window_outside_screen`. Candidate coordinates and raw
samples remain available. Missing display information (or `is_extended=false`)
does not certify the mapping. Desktop zoom, browser chrome, display scaling,
and tracker/display identity still require verification on the actual setup.
Visible notification cards and unsent-write notices take precedence over the
content they cover; a modal excludes notices painted behind its backdrop.
Layout observations are coalesced to animation frames, and browser-window
movement is checked once per second. Samples around a change can therefore
reference the preceding layout. Transition intervals are not currently marked
uncertain; exact layout references alone do not establish transition timing.
The bridge timestamps gaze when its SDK callback arrives, which also leaves
device-to-callback latency unmeasured. Avoid treating transition samples as
precisely synchronized evidence until this has been validated or addressed.
An AOI debug overlay can verify the DOM rectangles and modal precedence. It
does **not** calibrate the tracker or establish physical gaze accuracy. Validate
with the lab's tracker, calibrated display and intended browser zoom before
interpreting small areas. AOI hits are sample labels, not fixations or dwell
time measurements.

## During a session

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
- **A participant cannot log in.** After too many attempts the login is refused
  for a minute — wait, then check the id in the admin.

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

## Timed CK pre-test

Apply migration `d9f1a3b5c7e2` before running the backend that records section
attempts and questionnaire visits. It adds the timing schema without changing
existing questionnaire content or session pointers.

New studies include the two existing CK self-assessment pages, the supplied CK
introduction and thirteen debugging tasks, then an editable PCK introduction
and the shared PCK example before MSK. The initial PCK intro uses the existing
generic “Bitte beantworten Sie die folgenden Fragen.” wording. The tasks use
section function `ck_tasks`, followed by PCK with function
`pck`. The section name is a display/export label; it does not activate the
timer. Put any editable section introduction on its first populated page only.
Empty draft pages remain hidden. Add future PCK items after the shared example
with the same `pck` function so the section stays consecutive.
Structural edits are refused once a participant has logged into the study;
prepare a new study for changes to questions, order, options or code.

The seven-minute timer starts when the first CK task opens, excluding the
introduction. Reload and supervisor back do not restart it. At zero the page
shows a notice and stays open. The supervisor presses **Ctrl+Alt+Shift+N**
(Cmd+Alt+Shift+N on a Mac) from a CK task, then confirms **Speichern und zu PCK**.
This saves the current partial answer and actual exit time and opens the PCK
introduction or first page. Unvisited tasks receive no answer or timestamps.
The shortcut has no effect outside CK. Like the existing back shortcut, it
uses the participant session and is a supervisor convention, not a separate
administrator authentication check.

If saving fails, keep the tab open and retry in the dialog. Drafts are local to
the participant. A finished section retains its original timing when reviewed;
subsequent visits are marked as review. Actual elapsed time may exceed seven
minutes if the supervisor intervenes late; the export records that overrun.

`responses.csv` stores a CK answer as an object under the question ID, with
`lines` (at most five numbers) and `explanation` (text). A supervisor exit may
leave either component absent or incomplete; `response_status=partial`
distinguishes it from a normal submission. PCK rankings are ordered arrays of
the configured option values. Multiple-answer checkbox questions use
`multi_select` and export an array of the selected option values, preserving
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

The October source snapshot and safe import command are documented in
[`backend/app/data/README.md`](../backend/app/data/README.md). The approved CK
mapping retains the first `ck_pre_12`/`ck_pre_13` and assigns later CSV rows
25/26 to `ck_pre_08`/`ck_pre_10`, preserving source order. The PCK example is kept
as supplied; its author-review notes do not prevent loading it. Additional
intro wording and PCK items can be edited before the first participant login.

Existing studies are not changed by the new defaults or schema migration.
The standard-battery seed action skips a pre-test placement that already has
pages. Use a new study for a new instrument version, or preview the guarded CK
import for a selected unstarted study whose populated PCK page already follows
self-assessment. The command uses the approved mapping unless an explicit
override is supplied, previews changes by default, and refuses studies with
started sessions or responses. A local draft and local tests do not deploy
the instrument to a live environment.
