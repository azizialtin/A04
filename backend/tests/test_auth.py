import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app.core.dependencies import get_current_admin, get_current_participant
from app.core.security import create_access_token
from app.models.enums import ParticipantStatus
from app.models.session import Session


async def test_participant_login_unknown_id_401(client):
    r = await client.post("/auth/participant/login", json={"participant_id": "NOBODY"})
    assert r.status_code == 401


async def test_participant_login_bootstraps_session(client, db, seed_participant):
    r = await client.post("/auth/participant/login", json={"participant_id": seed_participant.id})
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["token_type"] == "bearer"

    await db.refresh(seed_participant)
    assert seed_participant.status == ParticipantStatus.active
    session = await db.scalar(select(Session).where(Session.participant_id == seed_participant.id))
    assert session is not None
    assert session.current_step_index == 0


async def test_participant_login_is_idempotent(client, db, seed_participant):
    await client.post("/auth/participant/login", json={"participant_id": seed_participant.id})
    r = await client.post("/auth/participant/login", json={"participant_id": seed_participant.id})
    assert r.status_code == 200
    count = await db.scalar(
        select(func.count())
        .select_from(Session)
        .where(Session.participant_id == seed_participant.id)
    )
    assert count == 1


async def test_participant_login_is_case_insensitive(client, seed_participant):
    r = await client.post(
        "/auth/participant/login", json={"participant_id": seed_participant.id.lower()}
    )
    assert r.status_code == 200


async def test_completed_participant_is_blocked(client, db, seed_participant):
    seed_participant.status = ParticipantStatus.completed
    await db.flush()
    r = await client.post("/auth/participant/login", json={"participant_id": seed_participant.id})
    assert r.status_code == 403


async def test_admin_login_ok(client, seed_researcher):
    r = await client.post(
        "/auth/admin/login",
        json={"email": seed_researcher.email, "password": "testpassword12"},
    )
    assert r.status_code == 200
    assert r.json()["access_token"]


async def test_admin_login_wrong_password_401(client, seed_researcher):
    r = await client.post(
        "/auth/admin/login",
        json={"email": seed_researcher.email, "password": "wrong-one"},
    )
    assert r.status_code == 401


async def test_admin_login_unknown_email_401(client):
    r = await client.post(
        "/auth/admin/login", json={"email": "ghost@a04.test", "password": "whatever"}
    )
    assert r.status_code == 401


async def test_admin_login_is_throttled(client, seed_researcher):
    for _ in range(10):
        await client.post(
            "/auth/admin/login",
            json={"email": seed_researcher.email, "password": "wrong-one"},
        )
    r = await client.post(
        "/auth/admin/login",
        json={"email": seed_researcher.email, "password": "wrong-one"},
    )
    assert r.status_code == 429


# --- dependencies ----------------------------------------------------------


async def test_get_current_participant_ok(db, seed_participant):
    token = create_access_token({"sub": seed_participant.id, "role": "participant"})
    p = await get_current_participant(token=token, db=db)
    assert p.id == seed_participant.id


async def test_get_current_participant_rejects_garbage(db):
    with pytest.raises(HTTPException) as exc:
        await get_current_participant(token="not-a-jwt", db=db)
    assert exc.value.status_code == 401


async def test_get_current_participant_rejects_admin_role(db, seed_participant):
    token = create_access_token({"sub": seed_participant.id, "role": "admin"})
    with pytest.raises(HTTPException) as exc:
        await get_current_participant(token=token, db=db)
    assert exc.value.status_code == 401


async def test_get_current_admin_ok(db, seed_researcher):
    token = create_access_token({"sub": seed_researcher.email, "role": "admin"})
    r = await get_current_admin(token=token, db=db)
    assert r.email == seed_researcher.email


async def test_get_current_admin_rejects_participant_role(db, seed_researcher):
    token = create_access_token({"sub": seed_researcher.email, "role": "participant"})
    with pytest.raises(HTTPException) as exc:
        await get_current_admin(token=token, db=db)
    assert exc.value.status_code == 401


@pytest.mark.parametrize("same_participant", [True, False])
@pytest.mark.parametrize("with_sets", [True, False])
async def test_simultaneous_first_logins_create_one_run_and_preserve_balanced_dealing(
    monkeypatch, same_participant, with_sets
):
    import asyncio
    from uuid import uuid4

    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import delete
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.api import auth
    from app.core.database import get_db
    from app.models.participant import Participant
    from app.models.participant_video import ParticipantVideo
    from app.models.study import Study
    from app.models.video import Video
    from app.models.video_set import VideoSet, VideoSetItem
    from main import app
    from tests.conftest import TEST_DATABASE_URL

    engine = create_async_engine(TEST_DATABASE_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    ids = [f"CONCURRENT-{uuid4().hex}" for _ in range(1 if same_participant else 4)]
    async with factory() as db:
        study = Study(name="Concurrent login test", think_aloud_batch_size=2)
        db.add(study)
        await db.flush()
        db.add_all([Participant(id=pid, study_id=study.id) for pid in ids])
        if with_sets:
            video = Video(study_id=study.id, title="Concurrent clip")
            sets = [VideoSet(study_id=study.id, name=name) for name in ["A", "B"]]
            db.add_all([video, *sets])
            await db.flush()
            db.add_all(
                [
                    VideoSetItem(
                        video_set_id=s.id, video_id=video.id, slot_index=0, phase_type="training"
                    )
                    for s in sets
                ]
            )
        await db.commit()

    async def isolated_db():
        async with factory() as db:
            yield db

    original_deal = auth.deal_on_first_login
    calls = []

    async def slow_deal(db, participant):
        calls.append(participant.id)
        # Ensure the other requests reach the initial read before this commits.
        await asyncio.sleep(0.03)
        return await original_deal(db, participant)

    monkeypatch.setattr(auth, "deal_on_first_login", slow_deal)
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = isolated_db
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test"
        ) as client:
            responses = await asyncio.gather(
                *[
                    client.post(
                        "/auth/participant/login", json={"participant_id": ids[i % len(ids)]}
                    )
                    for i in range(4)
                ]
            )
        assert [r.status_code for r in responses] == [200] * 4
        assert sorted(calls) == sorted(ids)
        async with factory() as db:
            sessions = (
                await db.scalars(select(Session).where(Session.participant_id.in_(ids)))
            ).all()
            assert len(sessions) == len(ids)
            assert all(s.current_step_index == 0 for s in sessions)
            participants = (
                await db.scalars(select(Participant).where(Participant.id.in_(ids)))
            ).all()
            assert all(
                p.status == ParticipantStatus.active and p.think_aloud_batch_size == 2
                for p in participants
            )
            slots = await db.scalar(
                select(func.count())
                .select_from(ParticipantVideo)
                .where(ParticipantVideo.participant_id.in_(ids))
            )
            assert slots == (len(ids) if with_sets else 0)
            if with_sets and not same_participant:
                assert sorted(sum(p.video_set_id == s.id for p in participants) for s in sets) == [
                    2,
                    2,
                ]
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        async with factory() as db:
            await db.execute(
                delete(ParticipantVideo).where(ParticipantVideo.participant_id.in_(ids))
            )
            await db.execute(
                delete(VideoSetItem).where(
                    VideoSetItem.video_set_id.in_(
                        select(VideoSet.id).where(VideoSet.study_id == study.id)
                    )
                )
            )
            await db.execute(delete(Study).where(Study.id == study.id))
            await db.commit()
        await engine.dispose()
