import importlib.util
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select

from app.core.database import Base
from app.models.enums import ParticipantStatus, PhaseType
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.session import Session
from app.models.study import Study
from app.models.video import Video
from app.services.session_script import build_steps


def migration_module():
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic/versions/a1d3f5b7c9e2_pin_default_video_sequences.py"
    )
    spec = importlib.util.spec_from_file_location("video_sequence_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


async def test_migration_freezes_started_defaults_and_preserves_existing_slots(
    db, client, seed_study, admin_headers
):
    empty_study = Study(name="Empty run")
    db.add(empty_study)
    await db.flush()
    videos = [
        Video(study_id=seed_study.id, title=phase.value, phase_type=phase)
        for phase in (PhaseType.post_test, PhaseType.training, PhaseType.pre_test)
    ]
    started = [
        Participant(id=f"migration-{status}", study_id=seed_study.id, status=status)
        for status in (ParticipantStatus.active, ParticipantStatus.completed)
    ]
    session_only = Participant(id="migration-session", study_id=seed_study.id)
    unstarted = Participant(id="migration-unstarted", study_id=seed_study.id)
    assigned = Participant(
        id="migration-assigned", study_id=seed_study.id, status=ParticipantStatus.active
    )
    empty = Participant(
        id="migration-empty", study_id=empty_study.id, status=ParticipantStatus.active
    )
    db.add_all([*videos, *started, session_only, unstarted, assigned, empty])
    await db.flush()
    existing_slot = ParticipantVideo(
        participant_id=assigned.id,
        video_id=videos[0].id,
        slot_index=0,
        phase_type=PhaseType.training,
    )
    db.add(existing_slot)
    saved = Session(participant_id=session_only.id, current_step_index=12)
    db.add(saved)
    await db.flush()
    frozen = [*started, session_only, assigned, empty]
    before = {p.id: await build_steps(db, p) for p in [*frozen, unstarted]}
    old_slot_id = existing_slot.id
    migration = migration_module()
    connection = await db.connection()

    def migrate(conn):
        context = MigrationContext.configure(conn)
        with Operations.context(context):
            migration.downgrade()
            migration.upgrade()
        assert compare_metadata(context, Base.metadata) == []

    await connection.run_sync(migrate)
    for participant in [*frozen, unstarted]:
        await db.refresh(participant)
        assert participant.video_sequence_pinned == (participant is not unstarted)
        assert await build_steps(db, participant) == before[participant.id]
    await db.refresh(saved)
    assert saved.current_step_index == 12
    assigned_slots = list(
        (
            await db.scalars(
                select(ParticipantVideo).where(ParticipantVideo.participant_id == assigned.id)
            )
        ).all()
    )
    assert [(s.id, s.video_id, s.phase_type) for s in assigned_slots] == [
        (old_slot_id, videos[0].id, PhaseType.training)
    ]

    videos[0].phase_type = PhaseType.pre_test
    db.add_all(
        Video(study_id=study_id, title="Later upload", phase_type=PhaseType.training)
        for study_id in (seed_study.id, empty_study.id)
    )
    await db.flush()
    for participant in frozen:
        assert await build_steps(db, participant) == before[participant.id]
    assert await build_steps(db, unstarted) != before[unstarted.id]
    # Session-bearing imported rows stay locked even if their status is stale.
    response = await client.put(
        f"/admin/participants/{session_only.id}/videos",
        json={"items": []},
        headers=admin_headers,
    )
    assert response.status_code == 409


async def test_downgrade_refuses_to_unfreeze_an_empty_run(db, seed_participant):
    seed_participant.video_sequence_pinned = True
    await db.flush()
    migration = migration_module()
    connection = await db.connection()

    def downgrade(conn):
        with Operations.context(MigrationContext.configure(conn)):
            migration.downgrade()

    with pytest.raises(RuntimeError, match="Cannot unpin empty runs"):
        await connection.run_sync(downgrade)
