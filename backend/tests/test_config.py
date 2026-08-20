import pytest

from app.core.config import _PLACEHOLDER_SECRET as PLACEHOLDER
from app.core.config import Settings, production_problems

PROD = {
    "ENVIRONMENT": "production",
    "JWT_SECRET": "a-real-secret-long-enough-for-hs256",
    "GCP_BUCKET_NAME": "a04-media",
    "GAZE_STORAGE_MODE": "gcs",
    "SCREEN_STORAGE_MODE": "gcs",
}


def test_development_is_never_blocked():
    s = Settings(ENVIRONMENT="development", JWT_SECRET=PLACEHOLDER, GAZE_STORAGE_MODE="local")
    assert production_problems(s) == []


def test_fully_configured_production_passes():
    assert production_problems(Settings(**PROD)) == []


def test_production_rejects_the_placeholder_secret():
    problems = production_problems(Settings(**{**PROD, "JWT_SECRET": PLACEHOLDER}))
    assert len(problems) == 1
    assert "JWT_SECRET" in problems[0]


def test_production_rejects_local_gaze_storage():
    problems = production_problems(Settings(**{**PROD, "GAZE_STORAGE_MODE": "local"}))
    assert len(problems) == 1
    assert "GAZE_STORAGE_MODE" in problems[0]


def test_production_rejects_an_empty_bucket():
    problems = production_problems(Settings(**{**PROD, "GCP_BUCKET_NAME": ""}))
    assert len(problems) == 1
    assert "GCP_BUCKET_NAME" in problems[0]


def test_production_rejects_local_screen_storage():
    problems = production_problems(Settings(**{**PROD, "SCREEN_STORAGE_MODE": "local"}))
    assert len(problems) == 1
    assert "SCREEN_STORAGE_MODE" in problems[0]


def test_screen_storage_is_moot_with_recording_switched_off():
    s = Settings(**{**PROD, "SCREEN_STORAGE_MODE": "local", "SCREEN_RECORDING_ENABLED": False})
    assert production_problems(s) == []


def test_problems_accumulate():
    s = Settings(
        ENVIRONMENT="production",
        JWT_SECRET=PLACEHOLDER,
        GCP_BUCKET_NAME="",
        GAZE_STORAGE_MODE="local",
        SCREEN_STORAGE_MODE="local",
    )
    assert len(production_problems(s)) == 4


@pytest.mark.parametrize("field", ["GAZE_STORAGE_MODE", "SCREEN_STORAGE_MODE"])
def test_unknown_storage_mode_is_rejected_outright(field):
    with pytest.raises(ValueError, match=field):
        Settings(**{field: "s3"})


def test_production_rejects_a_secret_that_is_too_short():
    problems = production_problems(Settings(**{**PROD, "JWT_SECRET": "sixteen-bytes-ok"}))
    assert len(problems) == 1
    assert "at least 32" in problems[0]


def test_a_long_enough_secret_passes():
    assert production_problems(Settings(**{**PROD, "JWT_SECRET": "x" * 32})) == []
