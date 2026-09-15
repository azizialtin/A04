# A04

Web platform for a personalised-learning study with programming teachers.
A run opens with a short in-tool pre-test (background, pedagogical content
knowledge, content knowledge), hands off to a SoSciSurvey questionnaire, and
calibrates the eye tracker. Participants then work through nine debugging cases
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
- ffmpeg, if you want the screen recording from the bridge (the bridge says so
  and carries on without it; a browser with no bridge at all records its own
  display instead, after asking once)

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

There is no self sign-up, so the first account is made from the command line
(with `DATABASE_URL` set, from `backend/`):

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
batteries from
`A04_DataCollection.xlsx` already on it (pre-test pages, the diagnosis
confidence rating, the questions after each case); the "Fragebögen" tab is where
they are edited, and where an older study can be given the ones it is missing.

## Tests

```bash
cd backend  && pytest                 # needs the a04_test database (docker compose up -d db)
cd backend  && ruff check . && ruff format --check . && mypy
cd frontend && npm run test           # vitest
cd frontend && npm run typecheck      # tsc --noEmit
cd frontend && npm run lint           # eslint
cd frontend && npm run e2e            # playwright — see frontend/e2e/README.md
```

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
