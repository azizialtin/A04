# A04 on the existing LRZ production VM

This deployment adds A04 alongside EMMA and LENS. It uses a separate database
(`a04_prod`), non-superuser database owner (`a04_prod_app`), independent JWT
secret, API/frontend containers and `/data/a04/runtime` media. The existing
PostgreSQL server and HTTPS entry point are shared. No Tobii bridge runs on the VM.

The source base is commit `9d5562b`. New studies use the November 2026 pre-test
manifest. Existing October instruments retain their historical IDs; the LRZ
adaptation does not rewrite study content or participant responses.

## Required host setup

- VM: `lmmedam-el-prod.srv.mwn.de`, IPv4 `141.40.11.162`.
- Proposed/confirmed application name: `a04.rdm.lab.lrz.de`.
- LRZ must create the DNS record and issue its trusted certificate. Existing
  EMMA/LENS certificates do not cover A04. Do not publish an AAAA record until
  the VM's IPv6 HTTPS routing/filtering is working.
- `/data` must be mounted. Docker and the existing shared Postgres must be healthy.
- The external Docker networks are `sharp-production_database` and
  `sharp-production_emma`; only A04's frontend joins the latter for the TLS proxy.
- The bridge and API do not need public ports. Private staging binds port 18044
  to `127.0.0.1` only. Public traffic will use the existing port 443.

`prepare_host.py` is an explicit first-install operation. It refuses an existing
A04 database/role/config and records EMMA/LENS table digests, uploaded-file hashes
and container IDs before making changes. Run only after the deployment choices
are confirmed and production initialization is authorized:

```sh
sudo python3 infrastructure/lrz/prepare_host.py \
  --release-id YOUR_IMMUTABLE_RELEASE \
  --origin https://a04.rdm.lab.lrz.de
```

The private environment is written to `/data/a04/runtime/config/deployment.env`,
mode 0600. Do not print, commit or include it in a source archive. Build on the VM
for its CPU architecture, from a versioned release under `/data/a04/releases/`:

```sh
sudo docker compose -p a04-production \
  --env-file /data/a04/runtime/config/deployment.env \
  -f infrastructure/lrz/compose.yml build
sudo docker compose -p a04-production \
  --env-file /data/a04/runtime/config/deployment.env \
  -f infrastructure/lrz/compose.yml run --rm migrate
sudo docker compose -p a04-production \
  --env-file /data/a04/runtime/config/deployment.env \
  -f infrastructure/lrz/compose.yml up -d --wait api web
```

The API runs read-only as UID/GID 10002. Only its explicit uploads and temporary
bind mounts are writable. `STORAGE_BACKEND=persistent_local` requires an absolute,
mounted, writable `LOCAL_STORAGE_ROOT`; a missing mount fails startup. Gaze and
screen storage must both be local and the cloud bucket must be empty. The default
cloud deployment retains its original bucket requirements.

Production local media are served through expiring, file-specific bearer links,
with GET/HEAD/range support and path containment checks. The raw uploads directory
is never publicly mounted in production. Proxy and API access logs do not retain
signed query strings. `/api` prefix handling preserves the normal request-size
limit while allowing the designated upload routes. Both proxy hops are accounted
for when deriving the client IP for rate limits and audit records.

## Private verification and public activation

For private access through SSH, forward local 18044 to VM loopback 18044 and open
`http://127.0.0.1:18044`. This is a staging check, not a public URL to distribute.
Verify login, uploads over 256 KiB, signed media seek, synthetic gaze/screen capture,
replay, exports and cleanup. Check that EMMA/LENS remain unchanged and healthy.

After DNS and the trusted A04 certificate are installed, place its certificate
chain and key under the existing proxy's mounted TLS directory as
`a04-fullchain.pem` and `a04-key.pem` (key mode 0600). Check the certificate hostname,
trust chain, validity and key match before activation. Back up the existing proxy
template, render `a04-vhost.conf.template` with the confirmed hostname, and append
only that server block. Preserve all existing server blocks and proxy settings.
Render the live config, run `nginx -t`, then reload rather than restarting the
proxy. If validation fails, restore the saved config without reloading.

The existing template mount is
`/data/sharp/releases/test-20261102/infrastructure/lrz/nginx.conf.template`.
Its location must be rechecked from the running container before editing.
Verify A04's actual HTTPS URL without certificate exceptions and recheck EMMA/LENS.
Independent off-campus access and the physical lab/browser bridge permissions need
separate verification. Do not declare public deployment complete from SSH alone.

## Researcher accounts and study data

There is no self-registration. Create Altin, Viviane and Anabel using the confirmed
login addresses and independent generated passwords, through `app.cli` or
`app.services.researchers.create_researcher`. Account creation must use stdin or a
protected file; do not put actual passwords in shell history or source code.
Use the existing admin UI for later resets, session revocation and password changes.

The previous project used `altin@lrz-test.com`-style login identifiers. These are
only proposed identifiers until confirmed for A04; no mail is sent by provisioning.

The local source database contains five small development/demo studies and 29
participants. Its eleven referenced video entries must be distinguished from
120 files in the uploads directory. Do not import participants, responses, gaze,
screen captures, sessions or audit logs. If study/material copying is requested,
copy only the selected studies, questionnaires, video sets and referenced stimulus
files, remapping IDs and verifying hashes. Do not copy every uploads file blindly.
A fresh empty study created with this release receives the current November
instrument; importing an older study does not silently rename its questions.

## Tobii on Windows

The deployed frontend connects to `ws://127.0.0.1:8766`. LENS uses 8765, so A04
cannot accidentally connect to its bridge. See `tobii-service/README-LRZ.txt` and
`start-lrz.ps1`. The actual lab PC needs the supported Python 3.10/Tobii SDK setup
or an existing frozen A04Bridge.exe package, plus ffmpeg. A Windows executable
must be built on Windows; a source archive is not an executable package.

The bridge accepts the exact application origin. Keep it bound to loopback.
A synthetic test uses `--mock` and test-pattern capture; real participant sessions
must not use mock mode. Validate physical tracker connection, calibrated display,
local-network browser permission, screen recording, clock alignment and replay on
the intended Windows lab machine. The in-app calibration remains off by default.

## Backups, rollback and capacity

Both the A04 database and media are needed. Allow approximately 1–1.5 GB per full
participant sitting for screen recordings. The initial host inventory showed
337 GB free on `/data`; monitor growth before each collection block.

For a consistent manual backup, stop only A04's API and frontend, dump `a04_prod`
with `pg_dump -Fc --no-owner --no-acl` from the existing database container, and
archive `/data/a04/runtime/uploads`. Publish the pair only after validating the
dump with `pg_restore --list`, listing the archive and recording checksums. Restart
only the A04 services that were running. Do not stop the shared database or the
EMMA/LENS services. Protect configuration/TLS keys separately.

Agree an off-server backup destination, retention and restore rehearsal before
real data collection. A same-server archive is not disaster protection. Never
restore over existing application databases or run `down -v` on production.
Restore into a new A04 database/storage directory, validate it, then switch only
A04. Before switching versions, retain the source release, running image IDs and
compatible database/media backup. Do not downgrade research-data migrations.
