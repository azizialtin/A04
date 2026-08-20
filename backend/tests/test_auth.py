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
