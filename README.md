# A04

Web platform for a personalised-learning study with programming teachers.
A new study uses the November 2026 pilot flow: an in-tool pre-test covering
background, CK, PCK and MESP, followed by a SoSciSurvey questionnaire and the
video phase. The pilot example has seven debugging cases (one pre-test, five
training, one post-test). For each case, participants watch a clip of students
struggling with code, take timed notes, write a diagnosis with a confidence
rating, and answer a short case questionnaire. By default, the last three cases
are discussed together after the video phase, using screen recordings with gaze
overlays. A second SoSciSurvey questionnaire closes the run. Case assignments
and the think-aloud settings remain configurable.

In-app eye-tracker calibration is optional and defaults off when the lab
calibrates externally. Existing studies and started runs retain their legacy
flow. See the [pilot protocol and rollout notes](docs/pilot-20261116.md) for
versioning, source content, migration limits and verification.

The stack is a FastAPI backend, a React + TypeScript frontend, and a small
bridge that runs on the lab machine and handles both the Tobii eye tracker and
the screen recording. It is self-contained — no dependency on any other
repository.

## Layout

```
backend/         FastAPI app, SQLAlchemy models, Alembic migrations, tests
frontend/        React + Vite + TypeScript SPA
tobii-service/   eye-tracker + screen-recording WebSocket bridge
infrastructure/  db bootstrap and deploy helpers
docs/            plan and notes
```

## Prerequisites

- Docker (for Postgres)
- Python 3.11+ and Node 22.12+ on the 22.x or 24.x LTS lines
- ffmpeg, if you want the screen recording from the bridge (the bridge carries
  on without it; when bridge capture is unavailable, the browser can record
  the display after the participant grants screen sharing)

## Run it locally

Start Postgres (creates the `a04` and `a04_test` databases on port 5434):

```bash
docker compose up -d db
```

Backend:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
alembic upgrade head          # once there are migrations
uvicorn main:app --reload --port 8030
```

Frontend:

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev                   # http://localhost:5175
```

Or bring the whole stack up with `docker compose up`.

## Admin

There is no self sign-up. The first account is made from the command line
(with `DATABASE_URL` set, from `backend/`); every further one can be added
under "Zugänge" at the bottom of the admin overview, where passwords are reset,
sessions ended and the own password changed as well:

```bash
python -m app.cli create-admin --email you@uni.example --name "Your Name"
python -m app.cli list-admins
python -m app.cli reset-password --email you@uni.example
python -m app.cli revoke-sessions --email you@uni.example   # sign out everywhere
python -m app.cli seed-questionnaires --study-id 3          # for studies made before P13
```

Researchers then manage studies at `/admin/login` (email + password): create a
study, upload videos with their case content, build the two video sets (the
fixed orders participants are dealt half and half at their first login), add
participants — and, where one person needs something else, hand-pick their
sequence or their set — edit the question batteries and the welcome page's
wording, and export the raw data as CSV. A new study arrives with the standard
batteries from the versioned pilot manifest, including the six-task MESP
instrument from `MESP_clean_mb.docx` (pre-test pages, the diagnosis confidence
rating, and the questions after each case); the "Fragebögen" tab is where they are edited,
and where an older study can be given the ones it is missing.

The gaze exports are separate: `gaze.csv` contains every stored sample at the
captured rate, with original eye coordinates, validity, timestamps, screen
context and AOI assignment; `gaze_recordings.csv` contains one metadata row per
recording. Gaze capture covers the case screen and the in-app pre-test,
diagnosis and post-case questionnaire screens. Older recordings remain
exportable, but AOIs are not invented for samples without their captured layout.
See [the gaze operations notes](docs/OPERATIONS.md#gaze-data-and-analysis) for
mapping limits, failed downloads and migration requirements.

## Tests

```bash
cd backend  && pytest                 # needs the a04_test database (docker compose up -d db)
cd backend  && ruff check . && ruff format --check . && mypy
cd frontend && npm run test           # vitest
cd frontend && npm run typecheck      # tsc --noEmit
cd frontend && npm run lint           # eslint
cd frontend && npm run test:browser   # Chromium, synthetic API/tracker, no database
cd frontend && npm run e2e            # playwright — see frontend/e2e/README.md
```

`test:browser` uses `playwright.feedback.config.ts`. Its capture check runs the
browser's native MediaRecorder encoder with a synthetic display stream; the OS
screen-share picker is mocked. It does not validate physical tracker hardware,
display permissions or calibration.

CI runs all of that, plus a dependency audit and a build of both Docker images.

Deployment notes live in [docs/DEPLOY.md](docs/DEPLOY.md); backups, retention,
erasure and monitoring in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Backups

```bash
scripts/backup.sh            # dumps Postgres and tars backend/uploads
```

Both halves are needed: restoring the database alone leaves rows pointing at
recordings that are gone.

## Security notes

Participant ids are the whole credential, so the admin generates random codes
by default rather than a walkable `TN-001` sequence, and both login forms are
rate limited per address. Admin sessions can be ended server-side with
`revoke-sessions`. CSV exports escape spreadsheet formula characters, and video
uploads are checked against their own container header before being stored.

CI audits both runtime and development dependencies with `npm audit` and
`pip-audit`. The frontend uses the maintained Vite 7.3 line and Vitest 5;
its browser build targets remain unchanged. A scoped `minimatch` 11 override
for `@typescript-eslint/typescript-estree` closes
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
while that parser still requests version 10. Remove the override when the
upstream dependency range includes the patched version. Python test tooling
uses pytest 9.0.3 with pytest-asyncio 1.3 to include the
[temporary-directory security fix](https://github.com/pytest-dev/pytest/releases/tag/9.0.3).
Use fresh installs from the lockfile/pinned requirements when auditing; an older
local environment can contain stale or unrelated packages.

## Ports

| Service          | Port |
| ---------------- | ---- |
| Postgres         | 5434 |
| Backend (uvicorn)| 8030 |
| Frontend (vite)  | 5175 |
