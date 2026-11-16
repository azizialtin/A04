import asyncio
import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base, get_db
from app.core.security import create_access_token
from app.models.enums import PhaseType
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant import Participant
from app.models.study import Study
from app.models.video import Video
from main import app
from tests.conftest import TEST_DATABASE_URL


@pytest_asyncio.fixture
async def video(db, seed_study):
    video = Video(study_id=seed_study.id, title="Assigned", phase_type=PhaseType.training)
    db.add(video)
    await db.flush()
    return video


def write_body(kind, video_id, request_id=None):
    body = (
        {"text": "Draft", "video_time_seconds": 5}
        if kind == "notes"
        else {"event_type": "video_paused", "payload": {"video_time_seconds": 5}}
    )
    body.update(video_id=video_id, client_ts=1000)
    if request_id is not None:
        body["request_id"] = request_id
    return body


@pytest.mark.parametrize("kind", ["notes", "events"])
async def test_exact_retry_is_idempotent_and_conflicting_retry_cannot_overwrite(
    client, db, video, participant_headers, kind
):
    body = write_body(kind, video.id, str(uuid4()))
    replies = [
        await client.post(f"/participant/{kind}", headers=participant_headers, json=body)
        for _ in range(2)
    ]
    assert [r.status_code for r in replies] == ([201, 201] if kind == "notes" else [202, 202])
    assert replies[0].json() == replies[1].json()
    conflict = await client.post(
        f"/participant/{kind}", headers=participant_headers, json={**body, "client_ts": 1001}
    )
    assert conflict.status_code == 409
    model = Note if kind == "notes" else InteractionLog
    rows = list((await db.scalars(select(model))).all())
    assert len(rows) == 1 and rows[0].client_ts == 1000
    if kind == "notes":
        assert await db.scalar(select(func.count()).select_from(InteractionLog)) == 1


async def test_legacy_note_identity_distinguishes_later_snapshots_and_unstamped_writes(
    client, db, video, participant_headers
):
    body = write_body("notes", video.id)
    for ts in (1000, 1000, 1001, None, None):
        response = await client.post(
            "/participant/notes", headers=participant_headers, json={**body, "client_ts": ts}
        )
        assert response.status_code == 201
    rows = list((await db.scalars(select(Note).order_by(Note.id))).all())
    assert [row.client_ts for row in rows] == [1000, 1001, None, None]
    assert await db.scalar(select(func.count()).select_from(InteractionLog)) == 4


async def test_request_identity_is_scoped_to_participant_and_write_kind(
    client, db, video, seed_study, participant_headers
):
    other = Participant(id="retry-other", study_id=seed_study.id)
    db.add(other)
    await db.flush()
    other_headers = {
        "Authorization": f"Bearer {create_access_token({'sub': other.id, 'role': 'participant'})}"
    }
    key = str(uuid4())
    for headers in (participant_headers, other_headers):
        for route in ("notes", "events"):
            response = await client.post(
                f"/participant/{route}", headers=headers, json=write_body(route, video.id, key)
            )
            assert response.status_code == (201 if route == "notes" else 202)
    assert await db.scalar(select(func.count()).select_from(Note)) == 2
    assert await db.scalar(select(func.count()).select_from(InteractionLog)) == 4


@pytest.mark.parametrize("kind", ["notes", "events"])
async def test_failed_commit_returns_retryable_error_then_same_request_succeeds(
    client, db, video, participant_headers, monkeypatch, kind
):
    await db.commit()
    body = write_body(kind, video.id, str(uuid4()))
    original_commit = db.commit

    async def fail_commit():
        raise OperationalError("COMMIT", {}, ConnectionError("Storage unavailable"))

    monkeypatch.setattr(db, "commit", fail_commit)
    response = await client.post(f"/participant/{kind}", headers=participant_headers, json=body)
    assert response.status_code == 503
    assert await db.scalar(select(func.count()).select_from(Note)) == 0
    assert await db.scalar(select(func.count()).select_from(InteractionLog)) == 0
    monkeypatch.setattr(db, "commit", original_commit)
    response = await client.post(f"/participant/{kind}", headers=participant_headers, json=body)
    assert response.status_code == (201 if kind == "notes" else 202)


async def test_session_event_without_video_is_durable_and_retryable(
    client, db, participant_headers
):
    body = {"event_type": "calibration_started", "request_id": str(uuid4()), "client_ts": 1000}
    for _ in range(2):
        response = await client.post("/participant/events", headers=participant_headers, json=body)
        assert response.status_code == 202
    rows = list((await db.scalars(select(InteractionLog))).all())
    assert len(rows) == 1 and rows[0].video_id is None and rows[0].client_ts == 1000


async def test_event_retry_preserves_json_types_and_ignores_object_key_order(
    client, db, participant_headers
):
    key = str(uuid4())
    body = {
        "request_id": key,
        "event_type": "info_opened",
        "payload": {"flags": [True], "source": "rail"},
    }
    assert (
        await client.post("/participant/events", headers=participant_headers, json=body)
    ).status_code == 202
    reordered = {**body, "payload": {"source": "rail", "flags": [True]}}
    assert (
        await client.post("/participant/events", headers=participant_headers, json=reordered)
    ).status_code == 202
    changed = {**body, "payload": {"source": "rail", "flags": [1]}}
    assert (
        await client.post("/participant/events", headers=participant_headers, json=changed)
    ).status_code == 409
    assert (await db.scalar(select(InteractionLog))).payload == body["payload"]


@pytest.mark.parametrize("kind", ["notes", "events"])
@pytest.mark.parametrize("conflicting", [False, True])
async def test_competing_write_retries_commit_once_and_are_visible_before_acknowledgement(
    monkeypatch, kind, conflicting
):
    engine = create_async_engine(TEST_DATABASE_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    pid = f"RETRY-{uuid4().hex}"
    async with factory() as db:
        study = Study(name="Concurrent ingestion")
        db.add(study)
        await db.flush()
        video = Video(study_id=study.id, title="Clip", phase_type=PhaseType.training)
        db.add_all([video, Participant(id=pid, study_id=study.id)])
        await db.commit()
    rendezvous = asyncio.Event()
    arrivals = 0

    async def isolated_db():
        nonlocal arrivals
        async with factory() as db:
            arrivals += 1
            if arrivals == 2:
                rendezvous.set()
            await asyncio.wait_for(rendezvous.wait(), timeout=5)
            yield db

    previous_overrides = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = isolated_db
    body = write_body(kind, video.id, str(uuid4()))
    headers = {
        "Authorization": f"Bearer {create_access_token({'sub': pid, 'role': 'participant'})}"
    }
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            replies = await asyncio.wait_for(
                asyncio.gather(
                    client.post(f"/participant/{kind}", headers=headers, json=body),
                    client.post(
                        f"/participant/{kind}",
                        headers=headers,
                        json={**body, "client_ts": 1001 if conflicting else 1000},
                    ),
                ),
                timeout=10,
            )
        success = 201 if kind == "notes" else 202
        assert sorted(r.status_code for r in replies) == [success, 409 if conflicting else success]
        async with factory() as db:
            model = Note if kind == "notes" else InteractionLog
            rows = list((await db.scalars(select(model).where(model.participant_id == pid))).all())
            assert len(rows) == 1
            assert rows[0].client_ts in ({1000, 1001} if conflicting else {1000})
            logs = list(
                (
                    await db.scalars(
                        select(InteractionLog).where(InteractionLog.participant_id == pid)
                    )
                ).all()
            )
            assert len(logs) == 1
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        async with factory() as db:
            await db.execute(delete(Study).where(Study.id == study.id))
            await db.commit()
        await engine.dispose()


async def test_retry_migration_preserves_duplicate_historical_snapshots(
    db, seed_participant, video
):
    for _ in range(2):
        db.add(
            Note(
                participant_id=seed_participant.id,
                video_id=video.id,
                video_time_seconds=5,
                client_ts=1000,
                text="Original",
            )
        )
        db.add(
            InteractionLog(
                participant_id=seed_participant.id,
                video_id=video.id,
                event_type="video_play",
                client_ts=1000,
                payload={"time": 5},
            )
        )
    await db.flush()
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic/versions/c3f5a7b9d1e4_idempotent_participant_writes.py"
    )
    spec = importlib.util.spec_from_file_location("write_retry_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    def migrate(connection):
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.downgrade()
            migration.upgrade()
        assert compare_metadata(context, Base.metadata) == []

    await (await db.connection()).run_sync(migrate)
    notes = list((await db.scalars(select(Note))).all())
    events = list((await db.scalars(select(InteractionLog))).all())
    assert len(notes) == len(events) == 2
    assert all(n.request_key is None and n.text == "Original" for n in notes)
    assert all(e.request_id is None and e.payload == {"time": 5} for e in events)
