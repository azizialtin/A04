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
- **Video playback.** The seeded clip is a valid container header and nothing
  more; the case screen is exercised, the decoder is not.
- **The admin UI.** The seeding goes through the admin *API*, so those
  endpoints are exercised, but nobody clicks through the admin screens.

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
