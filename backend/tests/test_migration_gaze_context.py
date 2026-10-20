import importlib.util
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

from app.core.database import Base
from app.models.gaze_recording import GazeRecording
from app.models.video import Video


async def test_gaze_migration_preserves_legacy_context_and_matches_models(
    db, seed_study, seed_participant
):
    video = Video(study_id=seed_study.id, title="Legacy")
    db.add(video)
    await db.flush()
    rec = GazeRecording(
        participant_id=seed_participant.id,
        video_id=video.id,
        geometry=[{"ts": 1000}],
        sample_count=123,
    )
    db.add(rec)
    await db.flush()
    path = (
        Path(__file__).resolve().parents[1] / "alembic/versions/c8e2f4a6b9d1_gaze_screen_context.py"
    )
    spec = importlib.util.spec_from_file_location("gaze_context_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    connection = await db.connection()

    def migrate(conn):
        conn.execute(text("ALTER TABLE gaze_recordings DROP COLUMN questionnaire_id"))
        conn.execute(text("ALTER TABLE gaze_recordings DROP COLUMN step_index"))
        conn.execute(text("ALTER TABLE gaze_recordings DROP COLUMN step_kind"))
        conn.execute(text("ALTER TABLE gaze_recordings ALTER COLUMN video_id SET NOT NULL"))
        context = MigrationContext.configure(conn)
        with Operations.context(context):
            migration.upgrade()
        assert compare_metadata(context, Base.metadata) == []

    await connection.run_sync(migrate)
    row = (
        await db.execute(text("SELECT step_kind, sample_count, geometry FROM gaze_recordings"))
    ).one()
    assert row.step_kind == "case_video" and row.sample_count == 123
    assert row.geometry == [{"ts": 1000}]
    db.add(GazeRecording(participant_id=seed_participant.id, step_kind="questionnaire"))
    await db.flush()

    def refuses_data_loss(conn):
        with Operations.context(MigrationContext.configure(conn)), pytest.raises(RuntimeError):
            migration.downgrade()

    await connection.run_sync(refuses_data_loss)
