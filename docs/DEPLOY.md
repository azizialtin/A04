# Deployment

A04 is four pieces: the FastAPI backend, the static React frontend, Postgres,
and — lab-side only — the Tobii bridge.

## Images

Both apps build from their own directory (they're self-contained):

```bash
docker build -t a04-backend ./backend
docker build --build-arg VITE_API_BASE_URL=https://api.example.org -t a04-frontend ./frontend
```

`docker compose up` runs the whole stack locally (Postgres + backend + frontend).

## Migrations

Run once per release, before the new backend serves traffic (not on every
instance start):

```bash
cd backend && alembic upgrade head   # with DATABASE_URL set
```

## Backend configuration

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | `postgresql+asyncpg://…` (Cloud SQL in prod) |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `FRONTEND_URL` | comma-separated CORS origins |
| `GCP_BUCKET_NAME` | bucket for video, gaze and screen storage |
| `GAZE_STORAGE_MODE` | `gcs` in prod, `local` in dev |
| `SCREEN_STORAGE_MODE` | `gcs` in prod, `local` in dev |
| `SCREEN_RECORDING_ENABLED` | `false` turns the screen capture off entirely |
| `ENVIRONMENT` | `production` on the server |
| `PARTICIPANT_TOKEN_HOURS` | how long a participant stays signed in (default 12) |

With `ENVIRONMENT=production` the app refuses to start unless `JWT_SECRET` has
been changed, `GCP_BUCKET_NAME` is set, and both `GAZE_STORAGE_MODE` and
`SCREEN_STORAGE_MODE` are `gcs`. The storage checks are there because the app
otherwise falls back to the container's own filesystem, which on Cloud Run is
per-instance and in memory: videos, gaze and screen recordings written there are
gone at the next deploy.

Budget for the bucket accordingly. A screen recording is 1080p30 at CRF 28, so
roughly **100–200 MB per case** and **1–1.5 GB per participant** across the nine.

## First admin account

There is no self sign-up. After the first migration, with `DATABASE_URL`
pointing at the deployed database:

```bash
cd backend && python -m app.cli create-admin --email you@uni.example --name "Your Name"
```

It prompts for the password (twice, hidden). `reset-password`, `list-admins`
and `revoke-sessions` are there too.

Admin tokens carry the account's `token_version`. `revoke-sessions` bumps it,
which signs that account out everywhere — use it for a lost laptop or someone
leaving the project. A password reset does the same thing implicitly.

## Frontend configuration

The nginx image renders its config at start, so the content security policy is
set per deployment rather than baked into the image:

| Variable | Notes |
| --- | --- |
| `CSP_POLICY` | full `Content-Security-Policy` value |

The default suits the local stack. In production, `connect-src` has to name the
backend origin, and `media-src` the bucket host if clips are served from signed
GCS urls — otherwise videos and the gaze bridge are blocked by the browser. For
example:

```
CSP_POLICY="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: https://storage.googleapis.com; connect-src 'self' https://api.example.org ws://localhost:8765; frame-src https://www.soscisurvey.de; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
```

`ws://localhost:8765` stays in the policy even in production: the Tobii bridge
runs on the lab machine the browser is sitting at, not on the server.

## Cloud Run sketch

Backend → Cloud Run, with Cloud SQL (Postgres), a Cloud Storage bucket for
videos, gaze chunks and screen recordings, and secrets in Secret Manager
(injected as env vars). The bridge uploads a finished capture straight to the
backend, so the Cloud Run request timeout and any upload limit in front of it
have to clear a few hundred megabytes.
Frontend → the nginx image on Cloud Run, or the built `dist/` on any static host
/ CDN; set `VITE_API_BASE_URL` at build time to the backend URL.

## Tobii bridge

Runs on the lab machine only (Python 3.10 + the Tobii Pro SDK). It also records
the screen, which needs **ffmpeg on PATH** — without it the bridge says so at
startup and the study runs on gaze alone. See `tobii-service/README.md`.
