# Contributing

Guidance for working in this repository.

## What A04 is

A research platform for a personalised-learning study with programming teachers.
A run opens with a welcome that lays out what is coming, then a short **in-tool
pre-test** — one page per block (background/demographics, PCK, CK) — and only
then the first **SoSciSurvey** hand-off and the eye-tracker calibration.

The participant then works through **nine cases** in one sitting — one pre-test,
seven training, one post-test — all mechanically identical; the phases are only
separated by a short "phase complete" screen. Each case has four stages:

1. **Intro** — short text, nothing asked.
2. **Case screen** — the clip on the left; on the right a countdown timer, the
   task, an **Info** button, a **Student task** button, and a **notes** box.
   Everything done here is logged (see `app/services/log_data.py`).
3. **Diagnosis** — the participant writes up what was wrong, with their own
   notes shown back to them, and rates their confidence on the same screen. Text
   and rating are one submission.
4. **Outro** — a closing line plus the short battery about effort and
   authenticity, again on one screen.
5. **Think-aloud** — a screen recording of the case replays with the
   participant's eye-gaze and their notes overlaid in sync; they narrate it to
   the study manager.

The think-aloud does not have to come straight after its own case. A study sets
how many **training** cases run before their think-alouds play back to back
(`think_aloud_batch_size`, 1 by default — the layout above). The pre-test and
post-test case never batch, so those two are always narrated while the
diagnosis is fresh. Batching only reorders steps, so a run has the same number
of them either way and the admin's progress fraction is unaffected. The value is
pinned onto the participant when the run opens, because a change that reordered
a sitting already under way would cost that participant a case.

A second **SoSciSurvey** questionnaire closes the run (both are opened in a new
tab with the participant id in the URL, so the two data sources can be linked),
followed by a thank-you.

The question wording comes from `A04_DataCollection.xlsx`; the transcription
lives in `backend/app/services/study_content.py`, and every question id is the
variable name from that data dictionary.

## Decisions that shape the code

- **Personalisation lives in the content, not the UI.** The only thing that
  differs between participants is *which videos, in which order*. A study
  carries two fixed **video sets** (A and B, each the nine cases in a set
  order); a participant is dealt one at their first login, balanced so the two
  end up half and half — the least-dealt set goes next, a tie is a coin toss.
  The set is *copied* into the participant's own slots at that moment, so
  editing a set never changes a run that has started, and a researcher can
  still hand-pick an individual sequence, which wins over the deal. So: no
  condition codes in the UI, no per-condition video variants, no prompt/overlay
  branching — one code path for everyone, and the set is a column on the
  participant for the analysis.
- **Questions are data, not screens.** Every battery — the pre-test pages, the
  diagnosis confidence rating, the post-case questions — is a `questionnaire`
  row run through one engine, so the researcher edits wording in the admin
  without a deploy, and every answer exports the same way. A new study is seeded
  with the standard set; a page with no questions yet (PCK) is skipped rather
  than shown empty. A study has as many pre-test pages as it likes but only one
  diagnosis and one outro battery, because those two render *inside* a screen
  and a second has nowhere to go. The welcome page's wording is study data in
  the same spirit (`study.texts`, edited on the "Details" tab): an empty field
  means the app's built-in text, and what is written shows in both interface
  languages, like the instrument itself. Presentation is data too where it has
  to be: a question's `matrix` key groups it with its neighbours that share
  the same options into one table, which is how the CK ladder is shown — the
  ids and the stored values stay the rows' own. The same `texts` object holds
  the page before each case. A study also carries `video_defaults`: the timer
  is copied into a video at upload, while a video with `use_default_task` /
  `use_default_info` set shows the study's text instead of its own, resolved
  when the script is built — so those clips follow later edits.
- **Standalone.** No shared package from any other repo. Infrastructure
  (config, db, security, middleware, logging, health) lives under
  `backend/app/core` and is ours to edit.
- **Think-aloud uses real eye tracking** (Tobii, like the lab's other studies):
  the tracker is calibrated (and the calibration validated) before the first
  case, gaze is streamed while the clip plays, then replayed as a dot on the
  think-aloud screen with the notes timeline.
- **What it is replayed over is a screen recording**, not the clip: the cursor,
  the notes box, the timer and every dialog the participant opened are part of
  what they are asked to narrate. ffmpeg records the whole display from inside
  the Tobii bridge — a browser tab capture does not draw the cursor, and the
  recording has to share the clock the gaze samples are stamped with. That makes
  the mapping `sample_ts - epoch_ms` with no geometry to undo. The screen
  recording does not depend on the tracker: a bridge without a tracker still
  records. **Without a bridge at all** the page records its own display through
  the browser's screen-share picker (asked once per page load, on the case
  intro), stamped `recorder = "browser"` so the analysis can tell — the clock
  anchor is the browser's and a frame or two less exact. The clip-only replay
  remains the last fallback when neither capture happened.
- **Gaze data only means something with its geometry and its clock.** The
  tracker reports gaze against the *whole display*. The screen recording is the
  whole display, so nothing has to be undone to draw on it — but each gaze
  recording still stores timestamped snapshots of where the clip sat on screen,
  because that is what places a sample on the *stimulus* for AOI analysis, and
  it cannot be reconstructed later. And because samples are stamped by the
  bridge, playback events and note snapshots carry a `client_ts` from the
  browser — all of it shares the lab machine's clock, the database does not.
- **German-first** UI. The *participant* side goes through i18next and ships a
  German and an English locale, because participants are not guaranteed to be
  German speakers. The *admin* side is German only, written as literals: it is
  used by this lab's own team, and translating it would be churn for an audience
  of three. That is a decision, not an oversight — if the admin ever needs a
  second language, it goes through i18next like everything else.
- **Single resumable session** (not multi-day).

## Code style — read this

The source is handed to external clients, so it must read like a person wrote
it, not a machine. Keep comments **short and about intent or gotchas**, not a
narration of the code. No banner/divider comments, no numpydoc "Parameters"
blocks, docstrings only where they actually help. Quality is not negotiable
(types, tests, clean structure) — the *prose* is what should stay human.

Every non-trivial change ships with tests. Backend: `pytest` against a real
Postgres test database, with `ruff` and `mypy` enforcing the rest — the style
rules above are gated in CI, not just written down here. Frontend: `vitest`,
plus a Playwright run of a participant's whole session (`frontend/e2e`).

## Architecture

**Backend** (`backend/`, FastAPI, async SQLAlchemy on Postgres). The participant
flow is a **linear step-script**: the backend computes an ordered list of steps
from the participant's assigned video sequence, the frontend renders
`steps[current_step_index]`, and a `PATCH …/progress` advances the pointer
(never backwards, so refresh/resume is safe). Step kinds:
`welcome | questionnaire | sosci | calibration | phase_transition | case_intro |
case_video | diagnosis | case_outro | think_aloud | thanks`.

Middleware order on a request: `RequestID → SecurityHeaders → CORS → BodySize →
route`.

**Frontend** (`frontend/`, React + Vite + TS). React Query for server state,
an auth context for the JWT session, React Router for routing.

**Auth.** Participants log in with an id only (pre-registered by an admin — no
self sign-up). Admins use email + password.

## Data model (target)

`researcher`, `study` (+ SoSci urls), `video` (phase, task/info/student-task
text, time limit, file), `video_set` / `video_set_item` (the study's fixed
orders, dealt at first login), `participant` (+ the set it was dealt),
`participant_video` (the ordered per-participant sequence — the
personalisation, whether dealt or hand-picked), `session` (step pointer),
`note` (text keyed to video time *and* wall clock), `text_entry` (the
diagnosis),
`questionnaire` / `questionnaire_response` (pre-test pages, whose responses have
no `video_id`; the diagnosis rating; the post-case battery),
`interaction_log`, `gaze_recording` (+ screen geometry), `screen_recording`
(the display capture + its clock anchor), `gaze_calibration`, `audit_log`.
**Consent is not in the data model** — it is taken on paper / in the first SoSci
survey, and that record is the one that counts.

## Commands

```bash
docker compose up -d db          # Postgres on 5434 (creates a04 + a04_test)

# backend
cd backend
pip install -r requirements-dev.txt
pytest
ruff check . && ruff format . && mypy
alembic upgrade head
python -m app.cli create-admin --email you@uni.example   # no self sign-up
python -m app.cli seed-questionnaires --study-id 3       # studies made before P13
uvicorn main:app --reload --port 8030

# frontend
cd frontend
npm install
npm run test
npm run typecheck
npm run dev                      # 5175

# eye tracker + screen recording (needs ffmpeg on PATH for the capture)
cd tobii-service
pip install -r requirements-dev.txt
pytest
python tobii_bridge.py --mock                         # synthetic gaze, test-pattern capture
python tobii_bridge.py --mock --screen-source display  # synthetic gaze, your real screen
```

Without a bridge running there is no gaze *and* no screen capture, and the
think-aloud quietly falls back to replaying the clip alone — no cursor, no
pauses. That fallback is by design; the footer says which one you are watching.

## Ports

Postgres 5434 · backend 8030 · frontend 5175.

## Build roadmap

See `docs/ROADMAP.md`. **P0–P14 done.** Participant flow (scaffold → data model
→ auth → step-script → shell → case/diagnosis → calibration → gaze +
think-aloud), the admin (studies, video upload, participants + sequence builder,
questionnaires, CSV exports, gaze listing + replay, audit), hardening (ESLint +
prettier + lint gate, GitHub Actions CI, `docs/DEPLOY.md`, PyJWT auth), and the
production blockers (admin bootstrap CLI, gaze geometry + clock, calibration,
production config guard), and data integrity (durable outbox for notes and
events, atomic gaze chunk claims, draft restore, batch id validation,
idempotent diagnoses, deadline-based timer, file cleanup on delete), and
security (CSV formula escaping, login rate limits, random participant ids,
upload validation, CSP + security headers, revocable admin sessions), and
operations (replay off the event loop, streaming exports, read-shaped indexes,
error reporting, `docs/OPERATIONS.md`), and tooling (ruff + mypy, admin split
into modules, end-to-end tests, CI gates and dependency audit), and the screen
recording behind the think-aloud (ffmpeg in the bridge, clock-anchored upload,
screen-relative gaze mapping, clip fallback, probed capture device), and the
instrument from `A04_DataCollection.xlsx` (in-tool pre-test pages, no questions
inside a case, diagnosis confidence, post-case battery, the full main-screen
event log), and the two video sets with the balanced deal plus the browser's own
screen capture for a machine without the bridge, and the wording a researcher
owns (welcome and case-intro texts, study-wide video defaults, the CK ladder as
one table), and think-aloud screens that can run in blocks, and exports a person
can read (timecodes, the step each progress row finished, a video list, row
counts on the tab) with a hand-over button between two sittings. Backend **356
pytest**, bridge **19 pytest**, frontend **150 vitest** + **3 Playwright** +
lint + typecheck + build, all green.

`docs/ROADMAP.md` has a **Still open** section — data integrity, security,
operations and test gaps that are known and not yet done. Read it before
assuming something is finished.
