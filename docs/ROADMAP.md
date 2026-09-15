# Build roadmap

Incremental, each phase runnable and tested before the next.

- [x] **P0 — Scaffold.** Repo, self-contained backend + frontend skeletons,
  Postgres via compose, test harness wired, health endpoint green.
- [x] **P1 — Data model + auth.** Models and migrations for study / video /
  participant / participant_video / session / note / text_entry / questionnaire
  / interaction_log / gaze_recording / audit. Participant id-login and admin
  email/password login. Tests for auth + schema.
- [x] **P2 — Step-script engine.** Backend builds the linear per-participant
  script and the participant endpoints (me, session, progress, video url,
  notes, diagnosis, questionnaire respond, events). Flow tests end to end.
- [x] **P3 — Frontend shell.** Router, auth context, i18n (German-first),
  SessionPage orchestrator, welcome / SoSci / phase-transition / info /
  questionnaire / thanks screens. (case_video / diagnosis / think_aloud render
  a placeholder until P4/P5.)
- [x] **P4 — Case screen + diagnosis.** Video + countdown timer + Info /
  Student-task panels + timestamped notes; diagnosis screen with notes shown
  back. (VideoPlayer already logs playback events for the P5 replay.)
- [x] **P5 — Gaze + think-aloud.** Tobii bridge (mock + real), gaze capture
  hook wired into the case player, and the participant think-aloud replay (gaze
  dot + notes timeline). Replay reconstruction is unit-tested; the mock bridge
  protocol is smoke-tested.
- [x] **P9 — Screen recording.** The think-aloud replays a capture of the whole
  display — the clip, the cursor, the notes box, every dialog — with gaze on
  top, instead of the clip alone. ffmpeg runs in the bridge so the recording
  shares the clock the samples are stamped with, which reduces the mapping to
  `sample_ts - epoch_ms`; the clip-only replay stays as the fallback when a
  capture fails, and the clip-relative gaze mapping stays for AOI analysis.
- [x] **P6 — Admin.** Studies (+ SoSci urls), video upload with case content,
  participants (bulk create + per-participant sequence builder + bulk-assign),
  per-case questionnaires, CSV exports, gaze-recording listing, audit log.
  (Named sequence templates and an in-admin gaze replay viewer deferred to P7;
  "bulk-assign a sequence to selected participants" covers the template need.)
- [x] **P7 — Hardening.** ESLint (flat config) + prettier + lint gate; GitHub
  Actions CI (backend pytest + `alembic check`; frontend lint/typecheck/test/
  build); `docs/DEPLOY.md`; admin gaze replay viewer; python-jose → PyJWT (kills
  the deprecation warnings); README pass. Deferred by choice: a deeper a11y
  audit, the vite 6 / vitest 3 major bump (dev-only advisories), and named
  sequence templates.
- [x] **P8 — Production blockers.** The six things standing between a working
  demo and a deployable study: an admin bootstrap CLI (there was no way to make
  the first account); gaze samples mapped onto the *picture* rather than plotted
  raw, with the capture-time screen geometry stored so old recordings stay
  re-analysable; playback events timed by the browser's clock instead of the
  database's; an eye-tracker calibration and validation step before the first
  case; a production config guard that refuses to boot into local-disk storage;
  and the repository under version control.
- [x] **P9 — Data integrity.** Gaze batches claim their chunk offset in one
  statement and the client uploads one batch at a time, so concurrent uploads
  can no longer overwrite each other. Notes and playback events go through a
  durable outbox that retries, survives a reload, is scoped to the participant
  who made them, and shows anything unsent on screen. The notes box comes back
  from its last snapshot and the diagnosis keeps a local draft. Participant ids
  are vetted as a batch (length, charset, duplicates) instead of one bad id
  failing the insert. Diagnoses are one per case, so a retry replaces rather
  than duplicates. The case timer counts against a fixed deadline.
  `time_spent_seconds` is recorded for the diagnosis and the questionnaires.
  Deleting a study, video or participant now deletes the files behind it.

- [x] **P10 — Security and privacy.** CSV exports escape the characters
  spreadsheets execute (and carry a BOM, so German text reads correctly in
  Excel). Both login forms are rate limited per address by a shared limiter
  that prunes its own keys; participant ids default to random codes rather than
  a walkable sequence. Video uploads are checked by extension, content type and
  the container's own header, and streamed to disk instead of being read whole
  into memory. nginx serves a content security policy and the rest of the header
  set, with immutable caching for hashed assets and `no-store` for the entry
  point. Admin tokens carry a `token_version`, so `revoke-sessions` and a
  password reset both end sessions that are already open; participant tokens
  expire in 12 hours rather than 24. The Tobii bridge checks the browser's
  `Origin` and shares one tracker across connections. Consent came out of the
  data model entirely: `consent_records`, the two participant columns and
  `CONSENT_VERSION` were never written to, and a schema implying a control the
  app does not have is worse than none — consent is taken on paper / in the
  first SoSci survey.

- [x] **P11 — Operations.** The think-aloud replay no longer blocks the event
  loop: chunk reading and parsing moved to a threadpool, the per-sample segment
  scan became a bisection, and the wire payload is thinned to what a screen can
  draw (the raw chunks stay the record, and the stats still report every sample
  that was captured). CSV exports stream from a server-side cursor instead of
  building the whole file in memory twice, and there is a calibration export.
  Bulk assign takes one query rather than one per participant. Four
  single-column indexes became composites matching how the tables are actually
  read. Unhandled errors are logged with their traceback and request id in the
  shape Cloud Error Reporting groups on, and a UI crash is posted to the
  interaction log. `scripts/backup.sh` and `docs/OPERATIONS.md` cover backups,
  a tested restore, retention, erasure and monitoring. Compose keeps uploads in
  a volume; video upload shows progress; deleting a video asks first.

- [x] **P12 — Tests and tooling.** `admin.py` split from one 1000-line file
  behind section comments into modules named for what they do; the route table
  was diffed before and after to prove nothing moved. ruff and mypy configured
  and clean, gated in CI along with a coverage floor. The admin endpoints that
  had no test now have 25; a full nine-case run is walked through the API; and
  Playwright walks a participant's session in a real browser — which caught a
  bug the 180-odd unit tests did not. CI gained the e2e job, a dependency audit
  and a build of both images. The audit found real advisories on its first run:
  `python-multipart` (the video upload parser), `starlette`, and an open-redirect
  in `react-router` — all upgraded, and the upgrade surfaced that the JWT secret
  guard never checked the key was long enough for HS256.

- [x] **P13 — The instrument.** The run now matches `A04_DataCollection.xlsx`.
  A welcome that says what is coming, then an in-tool pre-test — background and
  demographics, PCK, content knowledge — before the SoSci hand-off, one page per
  block. Nothing is asked inside a case any more: the intro is text, the written
  diagnosis carries its confidence rating on the same screen and in the same
  submission, and the closing screen carries the effort and authenticity
  battery. Batteries are `questionnaire` rows like everything else, seeded onto
  a study at creation (and on request), skipped while a page has no questions
  yet, and each question id is the variable name from the data dictionary. A
  pre-test response has no case, so `video_id` became nullable and the
  one-per-case constraint became two partial indexes. The main screen logs every
  event the analysis plan lists — entering and leaving, both dialogs, the notes
  field, typing bursts with their duration — and the export names each one as
  the data dictionary does. The VAS slider has no answer until it is touched, so
  a skipped rating is not recorded as a zero.

- [x] **P14 — Two video sets, and a capture without the bridge.** A study
  now carries fixed video orders — two, in the design — and a participant with
  no hand-picked sequence is dealt one at their first login. The deal is
  balanced rather than random: the least-dealt set goes next and only a tie is
  a coin toss, so the halves come out equal over the people who actually turn
  up. The set is copied into the participant's slots, so editing a set cannot
  change a run in progress; the participant list, the statistics and a new
  `participants.csv` export say who got which. And the screen recording no
  longer needs the bridge: when none is running (a test on a laptop, a lab
  machine that lost it) the page captures its own display through the browser's
  picker, asked once on the first case intro, and uploads it the same two ways
  the bridge does. Such a recording is stored as WebM under its own extension
  and marked `recorder = "browser"`, because its clock anchor is the browser's.

- [x] **P15 — Room to read, and words the researcher owns.** The question
  screens — the outro after each case, the pre-test pages, the ratings under
  the diagnosis — were a 680px card with long German items, a scale whose
  anchors wrapped, and a fieldset border drawn through every question text.
  They are now a wider form panel with each item on its own rule, the two
  anchors above the scale flush with its ends, likert points as equal-width
  cells, and a readout beside the slider. The welcome page's title,
  introduction, list of steps and id note can be written per study on the
  Details tab; empty means the built-in text. The CK self-assessment, eight
  concepts each followed by the same seven statements, is one table now: a
  question's `matrix` key groups it with its neighbours that share the
  options, the statements are listed once and numbered, and each row is a
  single choice under those numbers. The debugging ladder, whose statements
  differ, has a page of its own. A data migration gives studies seeded before
  this the same shape without touching any wording. The page before each case
  is editable the same way as the welcome page. And a study keeps defaults for
  new videos: a timer that is copied into each upload, and a task and info
  text a video can *follow* rather than copy — tick the box when uploading and
  the clip shows whatever the study's default says, now and after it is
  edited, so one wording is maintained in one place for sixteen clips.

- [x] **P16 — Think-aloud in blocks.** Validation asked for the training phase
  to be able to run *n* cases before their think-aloud screens play one after
  the other, rather than one narration per case. A study now carries that
  number (1 by default, which is the original layout); `think_aloud_groups`
  splits the cases into the blocks that share a run of narrations, and only the
  training phase batches — the pre-test and post-test case are always narrated
  immediately, and a block never spans a phase change, so a short final block
  is normal. Batching moves think-aloud steps without adding or removing one,
  which is what keeps `count_steps` honest. Each narration screen now says
  which case it is of ("Training · Fall 5 von 7", "Lautes Denken 2 von 3"),
  because three recordings in a row are otherwise a guess. The value is pinned
  onto the participant when their run opens, so an edit cannot reorder a
  sitting that has already begun.

- [x] **P17 — Exports you can read, and the hand-over between sittings.** Four
  things the researchers asked for after the first data came back. `events.csv`
  carries every video position as a timecode beside the raw seconds
  (`video_time`, and `video_time_from` for a seek), so a drag reads as
  `00:00 → 01:05` rather than as six decimal places; `notes.csv` does the same
  for the playhead a note was written at. A `progress_update` row now says
  *which* screen was finished — `describe_step` puts the questionnaire's title
  and page, or the case and its video, into the payload, and the export renders
  it in a `completed_step` column — because a row saying "step 4 of 54" named
  nothing. A `videos.csv` export gives every other file's `video_id` something
  to join against. The exports tab lists what each file holds and how many rows
  it has, so an empty download is legible: `calibration.csv` is empty by design
  wherever the tracker is calibrated in Eye Tracker Manager, and the tab says
  so rather than leaving it as a mystery. And the closing screen has a button
  back to the id prompt for the next participant, which signs the finished run
  out and clears its cache — it waits while the outbox still holds writes,
  since logging out parks them under an id nobody will sign in as again.

## Still open

Ordered roughly by cost of getting it wrong. See the production-readiness review
for the detail.

- **Deferred by choice.** The vite 6 / vitest 3 major bump — the remaining npm
  advisories are dev-toolchain only and never reach the bundle. A deeper
  accessibility audit. Named sequence templates beyond the video sets
  (bulk-assign covers the rest of the need).
- **The browser capture asks.** Chrome shows its screen-share picker once per
  page load and a "sharing your screen" bar for the rest of the session. Both
  can be suppressed with a managed-browser policy on the lab machines
  (`--auto-select-desktop-capture-source` / `ScreenCaptureAllowedByOrigins`),
  which is a deployment step nobody has taken yet. The bridge remains the
  intended recorder; this is the net under it.
- **Retention period.** `docs/OPERATIONS.md` describes how erasure works but
  the period itself is an ethics-board decision that has not been made. The
  screen recordings make it more pressing: ~1–1.5 GB per participant.
- **Screen recordings are not in the CSV exports.** They are listed in the admin
  and played in the replay viewer, but there is no manifest column tying a case
  to its capture for offline analysis.
- **Only the primary display is captured.** A dual-monitor lab machine records
  the display the tracker is calibrated against and nothing else, which is the
  intended setup but is not enforced anywhere.

- **The PCK pre-test has no items yet.** The spreadsheet says "to be discussed,
  10–15 questions". The page is seeded empty and skipped until someone writes
  them in the admin, so nothing is blocked — but the block is not measured
  either. Same for the MSK pre-test, which has no page at all yet.
- **The debugging pre-test task is not built.** `debug_exe_[1-10]` wants five to
  ten pages, each a screenshot of buggy code with a line-number field, a
  free-text reason, and page-entry/save timestamps. The screenshots do not
  exist yet; the CK self-assessment covers the block in the meantime.
- **No raw gaze-sample export.** Samples are captured and stored, and the replay
  reads them, but the CSV exports carry recording metadata only. The analysis
  plan asks for one chronological table per participant of the 100 ms samples
  and the main-screen log together.
- **The data dictionary has a typo we now copy.** Sheet "Log Data Collection on
  Main Screen" spells the winding variable `set_video_playhad_to`. The export
  reproduces it exactly, because that string is the key an analysis joins on —
  but if the sheet is corrected, `app/services/log_data.py` has to be corrected
  with it.
- **No AOI hit-testing.** The stimulus geometry is recorded with every
  recording, which is what makes it possible later, but nothing computes dwell
  time, fixations or time-to-first-fixation per AOI yet. The spreadsheet marks
  these as "nice to have" for 2026.

## Open questions carried forward

- Post-case questions: assumed the same short battery each case, answered once
  per case, and asked on the closing screen rather than a page of their own.
- Pre-test questions: assumed German, like the rest of the study content — the
  interface is translated, the instrument is not.
- Timer at zero: assumed the clip ends and the flow moves to the diagnosis.