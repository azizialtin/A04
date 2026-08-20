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
```

Run it after each participant. It writes a `pg_dump` custom-format file and a
tarball of the uploads, both stamped with the UTC time.

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

## During a session

- **A red banner at the bottom of the participant's screen** means writes are
  not reaching the server. The data is queued locally and will go up when the
  connection returns — do not close the tab or log out, which discards drafts.
- **The gaze dot is missing on the think-aloud screen.** Check the bridge is
  running and that the calibration step reported an accuracy. The admin replay
  viewer says explicitly when a recording has no screen geometry.
- **The think-aloud shows the clip instead of the screen recording.** The
  capture for that case failed. The Bildschirm column in the admin's gaze list
  says which and why — the usual cause is ffmpeg missing from the lab machine's
  PATH, which the bridge also prints at startup. The session is still usable;
  the participant narrates against the clip and the gaze.
- **A row stuck at "läuft…" in that column** is a capture whose upload never
  arrived. Look in `tobii-service/unsent-recordings/` on the lab machine: a file
  the backend would not take is kept there rather than deleted.
- **A participant cannot log in.** After too many attempts the login is refused
  for a minute — wait, then check the id in the admin.
