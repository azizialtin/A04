"""Initialize only the new A04 database and durable directories on LRZ."""

import argparse, hashlib, json, os, re, secrets, subprocess
from urllib.parse import urlsplit
from pathlib import Path
from datetime import datetime, timezone

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--release-id", required=True)
parser.add_argument("--origin", required=True)
args = parser.parse_args()
RELEASE_ID = args.release_id
ORIGIN = args.origin
assert re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,100}", RELEASE_ID), "Invalid release ID"
u = urlsplit(ORIGIN)
assert (
    u.scheme == "https"
    and u.hostname
    and u.netloc == u.hostname
    and not u.path
    and not u.query
    and not u.fragment
), "Origin must be one HTTPS hostname"
os.umask(0o077)
root = Path("/data/a04")
assert Path("/data").is_mount(), "/data must be mounted"
assert not (root / "runtime/config/deployment.env").exists(), (
    "A04 is already initialized; inspect before retrying"
)
assert (
    subprocess.run(
        ["docker", "inspect", "sharp-production-db-1"], stdout=subprocess.DEVNULL
    ).returncode
    == 0
)


def sql(db, query):
    p = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            "sharp-production-db-1",
            "psql",
            "-XqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            db,
        ],
        input=query,
        text=True,
        capture_output=True,
    )
    if p.returncode:
        raise RuntimeError("Database operation failed: " + p.stderr[:600])
    return p.stdout.strip()


def snapshot(db):
    names = json.loads(
        sql(
            db,
            "SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public';",
        )
    )
    result = {}
    for name in names:
        assert re.fullmatch("[a-z_]+", name)
        result[name] = json.loads(
            sql(
                db,
                f'''SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),',' ORDER BY md5(row_to_json(t)::text)),''))) FROM "{name}" t;''',
            )
        )
    return result


names = json.loads(sql("postgres", "SELECT json_agg(datname) FROM pg_database;"))
assert "a04_prod" not in names, "A04 database already exists"
assert not sql(
    "postgres", "SELECT rolname FROM pg_roles WHERE rolname='a04_prod_app';"
), "A04 role already exists"
prep = root / "preparation/20261102"
prep.mkdir(parents=True, exist_ok=False)
baseline = {
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "emma_tables": snapshot("emma_le"),
    "lens_tables": snapshot("lens"),
    "containers": {},
    "media": {},
}
for name in ["db", "emma-api", "emma-web", "lens-api", "lens-web", "proxy"]:
    c = json.loads(
        subprocess.check_output(
            ["docker", "inspect", "sharp-production-" + name + "-1"], text=True
        )
    )[0]
    baseline["containers"][name] = {
        "id": c["Id"],
        "image": c["Image"],
        "running": c["State"]["Running"],
    }
for app in ["emma", "lens"]:
    base = Path("/data/sharp/runtime") / app / "uploads"
    baseline["media"][app] = {}
    for p in sorted(base.rglob("*")):
        if p.is_file():
            with p.open("rb") as f:
                digest = hashlib.file_digest(f, "sha256").hexdigest()
            baseline["media"][app][str(p.relative_to(base))] = {
                "size": p.stat().st_size,
                "sha256": digest,
            }
(prep / "existing-apps-before.json").write_text(json.dumps(baseline, indent=2) + "\n")
for part in ["runtime/uploads", "runtime/tmp", "runtime/config", "releases", "backups"]:
    path = root / part
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    if part in ["runtime/uploads", "runtime/tmp"]:
        os.chown(path, 10002, 10002)
password = secrets.token_urlsafe(36)
jwt = secrets.token_hex(48)
sql(
    "postgres",
    f"CREATE ROLE a04_prod_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{password}';",
)
sql("postgres", "CREATE DATABASE a04_prod OWNER a04_prod_app;")
sql(
    "postgres",
    "REVOKE ALL ON DATABASE a04_prod FROM PUBLIC; GRANT CONNECT ON DATABASE a04_prod TO a04_prod_app;",
)
sql("a04_prod", "REVOKE CREATE ON SCHEMA public FROM PUBLIC;")
config = root / "runtime/config/deployment.env"
config.write_text(
    "RELEASE_ID="
    + RELEASE_ID
    + "\nDATA_ROOT=/data/a04/runtime\nPRIVATE_PORT=18044\nA04_ORIGIN="
    + ORIGIN
    + "\nDATABASE_URL=postgresql+asyncpg://a04_prod_app:"
    + password
    + "@sharp-production-db-1:5432/a04_prod\nJWT_SECRET="
    + jwt
    + "\n"
)
config.chmod(0o600)
report = {
    "root": str(root),
    "database": "a04_prod",
    "role": "a04_prod_app",
    "origin_prepared": ORIGIN,
    "source_release": RELEASE_ID,
    "existing_apps_snapshotted": True,
    "persistent_directories_initialized": True,
    "secrets_generated": True,
}
(prep / "initialization.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
