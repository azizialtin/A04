"""Runtime configuration, read from the environment (and a local .env)."""

from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Must be replaced before anything ships. get_settings() refuses to boot in
# production while this is still in place. Long enough not to trip PyJWT's
# short-key warning in dev, so the warning stays meaningful.
_PLACEHOLDER_SECRET = "dev-secret-change-me-before-you-ship-this"

# RFC 7518 3.2: an HMAC key for HS256 should be at least as long as the hash.
MIN_JWT_SECRET_BYTES = 32

_STORAGE_MODES = ("local", "gcs")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # Postgres, async driver. No SQLite fallback — we lean on JSONB and advisory
    # locks, and mixing engines between dev and prod hides bugs.
    DATABASE_URL: str = "postgresql+asyncpg://a04:a04@localhost:5434/a04"

    JWT_SECRET: str = _PLACEHOLDER_SECRET
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_HOURS: int = 24
    # A participant's run is a single sitting, so their token has no business
    # outliving the appointment by much.
    PARTICIPANT_TOKEN_HOURS: int = 12

    # Allowed browser origins for CORS, comma separated.
    FRONTEND_URL: str = "http://localhost:5175,http://localhost:5173"
    ENVIRONMENT: str = "development"

    # Video storage. Bucket empty in dev -> files are served off local disk.
    GCP_BUCKET_NAME: str = ""
    GCP_PROJECT_ID: str = ""

    # Gaze capture / storage.
    GAZE_STORAGE_MODE: str = "local"  # "local" | "gcs"
    GAZE_BATCH_UPLOAD_MAX_SAMPLES: int = 1000
    TOBII_EXPECTED_SAMPLE_RATE_HZ: int = 120

    # Whether the participant flow includes the in-app eye-tracker calibration
    # step. Off by default: the tracker is calibrated outside the app, in Tobii
    # Pro Eye Tracker Manager, before the participant sits down. Turn on only
    # for a setup that wants the in-app routine instead — a deployment that
    # leaves it on by accident shows participants a step it does not need.
    CALIBRATION_ENABLED: bool = False

    # Screen capture. The bridge records the lab machine's display while a case
    # clip is on screen; the think-aloud plays that back with gaze on top.
    SCREEN_RECORDING_ENABLED: bool = True
    SCREEN_STORAGE_MODE: str = "local"  # "local" | "gcs"
    # A 1080p30 case at CRF 28 is well under this; the cap is what stops a
    # misconfigured encoder filling the bucket.
    MAX_SCREEN_RECORDING_BYTES: int = 1024 * 1024 * 1024
    # The bridge holds this while it records and encodes, so it has to outlast a
    # long case — but it is scoped to one recording and does nothing else.
    SCREEN_UPLOAD_TOKEN_HOURS: int = 6

    # Dev only: placeholder clip returned when a stimulus has no file uploaded.
    DEV_PLACEHOLDER_VIDEO_URL: str = ""

    # Body-size cap for ordinary requests; upload routes get a bigger one in
    # the middleware.
    MAX_REQUEST_BODY_BYTES: int = 256 * 1024

    DB_POOL_SIZE: int = 5
    DB_MAX_OVERFLOW: int = 10
    DB_POOL_RECYCLE_SECONDS: int = 1800

    # Reverse-proxy hops to trust for X-Forwarded-For (Cloud Run's LB adds one).
    TRUSTED_PROXY_HOPS: int = 1

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @field_validator("DATABASE_URL")
    @classmethod
    def _require_postgres(cls, v: str) -> str:
        if not v.startswith("postgresql"):
            raise ValueError("DATABASE_URL must be a postgresql:// URL.")
        return v

    @field_validator("GAZE_STORAGE_MODE", "SCREEN_STORAGE_MODE")
    @classmethod
    def _known_storage_mode(cls, v: str, info) -> str:
        if v not in _STORAGE_MODES:
            raise ValueError(f"{info.field_name} must be one of {', '.join(_STORAGE_MODES)}.")
        return v


def production_problems(s: Settings) -> list[str]:
    """Settings that are survivable in dev but destroy data in production.

    Both storage checks exist because the app happily falls back to the
    container's own filesystem, which on Cloud Run is per-instance and in
    memory — videos and gaze chunks written there are gone at the next deploy,
    with nothing in the logs to say so.
    """
    if not s.is_production:
        return []

    problems = []
    if s.JWT_SECRET == _PLACEHOLDER_SECRET:
        problems.append(
            "JWT_SECRET is still the dev placeholder — generate one with `openssl rand -hex 32`."
        )
    elif len(s.JWT_SECRET.encode()) < MIN_JWT_SECRET_BYTES:
        problems.append(
            f"JWT_SECRET is {len(s.JWT_SECRET.encode())} bytes; HS256 wants at least "
            f"{MIN_JWT_SECRET_BYTES}. Generate one with `openssl rand -hex 32`."
        )
    if not s.GCP_BUCKET_NAME:
        problems.append(
            "GCP_BUCKET_NAME is empty — uploaded videos would go to local disk instead of the bucket."
        )
    if s.GAZE_STORAGE_MODE != "gcs":
        problems.append(
            f"GAZE_STORAGE_MODE is {s.GAZE_STORAGE_MODE!r} — gaze recordings would go to local disk "
            "instead of the bucket. Set it to 'gcs'."
        )
    if s.SCREEN_RECORDING_ENABLED and s.SCREEN_STORAGE_MODE != "gcs":
        problems.append(
            f"SCREEN_STORAGE_MODE is {s.SCREEN_STORAGE_MODE!r} — screen recordings are hundreds of "
            "megabytes each and would go to local disk instead of the bucket. Set it to 'gcs'."
        )
    return problems


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    problems = production_problems(s)
    if problems:
        raise RuntimeError("Refusing to start in production:\n  - " + "\n  - ".join(problems))
    return s
