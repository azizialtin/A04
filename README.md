# A04

Web platform for a personalised-learning study with programming teachers.
A run opens with a short in-tool pre-test (background, pedagogical content
knowledge, content knowledge), hands off to a SoSciSurvey questionnaire, and
optionally calibrates the eye tracker in-app. Calibration defaults off when
the lab calibrates externally. Participants then work through nine debugging cases
(one pre-test, seven training, one post-test): for each they watch a short clip
of students struggling with code, take timed notes, write a diagnosis with a
confidence rating, answer a short battery about the case, and talk a study
manager through what they looked at — over a screen recording of the case with
their gaze drawn on top. A second SoSciSurvey questionnaire closes the run.

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
- Python 3.11+ and Node 20+
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
batteries from `A04_DataCollection.xlsx` and the MSK instrument from
`MSK_items.docx` already on it (pre-test pages, the diagnosis confidence rating,
the questions after each case); the "Fragebögen" tab is where they are edited,
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

`npm audit` flags advisories in the **dev toolchain only** (vite / vitest /
esbuild) — none of it ships in the built bundle. The only remedy is a breaking
vite 6 / vitest 3 upgrade, deferred deliberately.

## Ports

| Service          | Port |
| ---------------- | ---- |
| Postgres         | 5434 |
| Backend (uvicorn)| 8030 |
| Frontend (vite)  | 5175 |
