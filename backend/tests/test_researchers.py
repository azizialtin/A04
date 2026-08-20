import pytest
from sqlalchemy import select

from app.core.security import verify_password
from app.models.researcher import Researcher
from app.services.researchers import (
    ProvisioningError,
    create_researcher,
    set_researcher_password,
)

PASSWORD = "correct-horse-battery"


async def test_create_researcher_stores_a_hash(db):
    researcher = await create_researcher(db, "New.Admin@Uni.example", PASSWORD, "New Admin")

    assert researcher.email == "new.admin@uni.example"
    assert researcher.name == "New Admin"
    assert researcher.password_hash != PASSWORD
    assert verify_password(PASSWORD, researcher.password_hash)


async def test_created_researcher_can_log_in(client, db):
    await create_researcher(db, "boot@uni.example", PASSWORD)

    r = await client.post(
        "/auth/admin/login", json={"email": "BOOT@uni.example", "password": PASSWORD}
    )
    assert r.status_code == 200
    assert r.json()["access_token"]


async def test_duplicate_email_is_refused(db):
    await create_researcher(db, "dupe@uni.example", PASSWORD)

    with pytest.raises(ProvisioningError, match="already exists"):
        await create_researcher(db, "DUPE@uni.example", PASSWORD)


async def test_short_password_is_refused(db):
    with pytest.raises(ProvisioningError, match="at least"):
        await create_researcher(db, "short@uni.example", "hunter2")

    assert (
        await db.scalar(select(Researcher).where(Researcher.email == "short@uni.example")) is None
    )


async def test_nonsense_email_is_refused(db):
    with pytest.raises(ProvisioningError, match="not an email"):
        await create_researcher(db, "not-an-email", PASSWORD)


async def test_reset_password_replaces_the_hash(db):
    researcher = await create_researcher(db, "reset@uni.example", PASSWORD)
    before = researcher.password_hash

    await set_researcher_password(db, "RESET@uni.example", "a-brand-new-password")

    assert researcher.password_hash != before
    assert verify_password("a-brand-new-password", researcher.password_hash)


async def test_reset_password_needs_an_existing_account(db):
    with pytest.raises(ProvisioningError, match="No researcher"):
        await set_researcher_password(db, "ghost@uni.example", PASSWORD)
