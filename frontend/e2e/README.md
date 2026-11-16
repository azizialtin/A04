# End-to-end tests

A participant walking their run in a real browser. The unit tests check each
screen; this checks that they join up — that the step script advances, that what
is typed reaches the server, and that the flow reaches the end.

It is worth the setup because the study gets one unrepeatable attempt per
person: "the run got stuck on case four" has to be found here rather than by a
participant.

## Running them

Needs Postgres, a database, and an admin account to seed through:

```bash
docker compose up -d db
createdb -h localhost -p 5434 -U a04 a04_e2e     # once

cd backend
DATABASE_URL=postgresql+asyncpg://a04:a04@localhost:5434/a04_e2e alembic upgrade head
DATABASE_URL=postgresql+asyncpg://a04:a04@localhost:5434/a04_e2e \
  python -m app.cli create-admin --email e2e@a04.test --name E2E --password e2e-password-1234

cd ../frontend
DATABASE_URL=postgresql+asyncpg://a04:a04@localhost:5434/a04_e2e npm run e2e
npm run e2e:ui        # to watch it happen
```

Playwright starts the backend (port 8031) and a preview server (4175) itself.
It builds the frontend as part of that, because Vite bakes `VITE_API_BASE_URL`
at build time — serving a `dist/` built for another backend is a confusing
failure that looks like a broken login.

## What it does not cover

- **The eye tracker.** There is none in CI. The in-app calibration step is off
  by default (the lab calibrates in Tobii Pro Eye Tracker Manager beforehand),
  so the run walks straight past it; with `CALIBRATION_ENABLED=true` the spec
  takes the documented no-tracker path through it instead. The gaze mapping is
  covered by unit tests either way.
- **The screen recording.** Headless Chromium has no bridge and refuses the
  display picker, so the case intro's capture attempt is declined and the
  think-aloud falls back to the clip — which is the path this exercises.
- **Study video content.** The pilot suite uses a short test-pattern clip, so
  playback and decoded dimensions are exercised, but production recordings are
  not loaded.
- **All admin workflows.** Most seeding uses the admin API. The pilot suite
  also edits think-aloud settings and text pages through the real admin UI,
  checks persistence after reload, and verifies that saved texts reach the
  participant. Other admin screen checks use synthetic API responses below.

## Feedback browser checks

`npm run test:browser` runs a separate Chromium suite on port 5185 with synthetic
API responses and tracker messages. It needs no database or admin account.
The fixture `fixtures/stimulus.webm` is a two-second 320×180 test pattern, so the
video element also has real decoded dimensions.

These checks cover case and questionnaire AOI rectangles at different viewport
sizes, scroll and popup visibility, seven line-number inputs, continuous code
line numbers, participant Details below a long roster, and real MediaRecorder
encoding/upload alongside gaze collection. The display stream is a synthetic
canvas: this does not test the OS screen-share picker or permissions.

AOI tests temporarily paint recorded rectangles red, save screenshots to
`test-results/`, remove the overlays, and save clean screenshots. No red tint is
added to the application. DOM alignment does not establish physical Tobii
accuracy: validate gaze-to-display mapping, browser zoom, screen selection,
calibration, and replay timing on the actual lab hardware.

The October feedback checks also inspect all thirteen default CK tasks in source
order, exact code numbering (including blank lines and two files), the five-entry
cap, the shared PCK ranking page, editable introductions, and native admin video
downloads. They exercise timer expiry without automatic progression, reload
drafts, supervisor skip, and retry after a lost acknowledgement. The fixtures
use the November source's corrected IDs 01–13 and assert that the source
exercise order stays unchanged. Admin browser checks also exercise editing an
existing video's wording, failed-save retry, default-text toggles and persistence
after reload. CK statistics checks distinguish actual elapsed time from response
sums, partial answers, review snapshots and unobserved exits.

`timed-pretest.spec.ts` runs through the real API and Postgres in the ordinary
`npm run e2e` suite. It checks persisted timing and partial answers against CSV
exports, and captures all 24 legacy pre-test pages with conditional fields and
five CK line entries visible at 1920×1080. This is a browser viewport assumption for regression
checks; the actual lab monitor, scaling and zoom still need verification.

The ordinary participant walkthrough also captures welcome, survey handoffs,
phase/case introductions, case screens and popup, diagnosis, unanswered/answered
post-case forms, think-aloud and completion at that viewport. The overflow
assertion runs after the full walk so a tall page does not hide later findings.

## November 16 pilot

`pilot-flow.spec.ts` creates a fresh study using the new defaults and walks the
full 69-page script: five training cases plus pre/post cases, with the last
three cases replayed in the discussion phase. It verifies explicit CK skip
values in CSV, all PCK pages including the exact-two selection, all six MESP
pages with 30 independently rated statements, neutral participant labels, and
student-task code formatting. It captures PCK/MESP pages, transition pages and
the video rail, checks horizontal overflow, and asserts vertical fit on each
PCK page before answering and before advancing. The post-questionnaire intro
must show its supplied paragraph without an added default heading.

`feedback-pilot-layout.spec.ts` checks all three complete pilot PCK pages at
1920×1080 CSS pixels, with unanswered, incomplete and completed responses. It
checks page and internal overflow, fully visible controls, readable font sizes,
authored DOM order, exact code lines and gaze-prompt positions. These assertions
run before navigation, because Playwright's normal click/fill helpers can
silently scroll offscreen fields into view. Source task 3 includes all 17 lines
of the refreshed code rather than a shortened formatting variant.

The same layout suite covers the full MESP introduction and all six MESP pages,
including the integrated scale headers and unchanged strategy order.
`feedback-replay-layout.spec.ts` checks the first bundled think-aloud page at
1920×1080 with healthy capture, clip fallback, missing gaze, missing audio and
both warnings together. It verifies page/internal overflow, replay proportions,
the gaze toggle and full visibility of “Weiter” before navigating. Narrow and
short viewport cases also check natural scrolling, preserved video proportions
and reachable controls.

A separate reload/expiry test preserves a partial CK answer, finishes the
section automatically, and enters PCK. To avoid a seven-minute test wait, it
changes the deadline only in the isolated test database; the database name
must contain `e2e`. There is no production clock-override endpoint. Existing
walkthroughs explicitly create legacy studies to check compatibility.

See [pilot rollout notes](../../docs/pilot-20261116.md) for the versioned
content, migration and lab checks.

## Data retention and validation regressions

`feedback-data-retention.spec.ts` covers edits immediately before reload or
timer expiry, offline note restoration, recovery without a pagehide event,
immutable retries after a lost acknowledgement, older queued writes, and the
end-page handoff after a reload. It also verifies that another participant's
queued notes are neither displayed nor sent as the current participant.

`feedback-calibration.spec.ts` supplies real WebSocket messages for absent,
partial, invalid and valid validation samples. Only the valid measurement may
report success. `feedback-admin-accessibility.spec.ts` checks accessible names
and submission of study and participant creation controls. These run with the
other feedback checks; the physical eye tracker remains a lab acceptance check.

`feedback-navigation.spec.ts` distinguishes a browser offline signal from an
unreachable API. It checks case-intro continuation, visible request errors and
retry, supervisor navigation, session refetch and reload. The real-API pilot
walk also sends an offline signal before case 2 and requires the saved pointer
to move from 37 to 38 while the API remains reachable. This regression failed
before the query network-mode fix. The original intermittent trace did not
record connectivity state, so its initiating event is still unknown.

`feedback-aoi-inventory.spec.ts` declares its own 1920×1080 viewport and checks
all thirteen CK tasks, all three PCK pages, all six MESP pages, questionnaire
controls, case/diagnosis/outro regions, dialogs and delivery warnings. It
compares captured rectangles and their foreground hits with the rendered DOM,
then writes geometry fixtures for backend CSV verification. Resize, scroll,
fullscreen, scaled display metrics and replay-dot positioning are included.
The geometry fixture uses low-rate synthetic gaze with 120 Hz metadata; the
backend's separate `test_lab_gaze.py` verifies native 120 Hz sample timestamps,
chunk retries, CSV preservation and clip mapping. Neither test certifies
physical tracking or Edge desktop page zoom.
