import importlib.util
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

from app.core.database import Base
from app.models.screen_recording import ScreenRecording
from app.models.video import Video


async def test_audio_migration_does_not_claim_legacy_recordings_have_sound(
    db, seed_study, seed_participant
):
    video = Video(study_id=seed_study.id, title="Legacy")
    db.add(video)
    await db.flush()
    recording = ScreenRecording(
        participant_id=seed_participant.id,
        video_id=video.id,
        status="stored",
        epoch_ms=1700000000000,
        storage_path="legacy.webm",
    )
    db.add(recording)
    await db.flush()
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic/versions/e6a2b8c4d0f1_screen_stimulus_audio.py"
    )
    spec = importlib.util.spec_from_file_location("screen_audio_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    connection = await db.connection()

    def migrate(conn):
        context = MigrationContext.configure(conn)
        with Operations.context(context):
            migration.downgrade()
            migration.upgrade()
        assert compare_metadata(context, Base.metadata) == []

    await connection.run_sync(migrate)
    row = (
        await db.execute(
            text("SELECT audio_status, audio_error, epoch_ms, storage_path FROM screen_recordings")
        )
    ).one()
    assert row.audio_status == "unknown"
    assert row.audio_error is None
    assert row.epoch_ms == 1700000000000
    assert row.storage_path == "legacy.webm"
