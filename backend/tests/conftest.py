"""Test harness: a real Postgres test DB, with each test rolled back.

Schema is created once for the session. Every test then runs inside an outer
transaction bound to a single connection; the session joins it in
create_savepoint mode, so endpoint commit()s only release savepoints and the
outer rollback at teardown discards everything the test wrote.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

import app.models  # noqa: F401  — register tables before create_all
from app.core.database import Base, get_db
from app.core.security import create_access_token, hash_password
from app.models.participant import Participant
from app.models.researcher import Researcher
from app.models.study import Study

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://a04:a04@localhost:5434/a04_test",
)

# Tearing down a NullPool engine per test leaves asyncpg with a `Connection._cancel`
# coroutine it never awaits, which pytest reports as an unraisable exception. It is
# a harness artifact — nothing in the app creates it — and the alternative, a
# session-scoped engine, reintroduces the cross-event-loop problem this fixture
# exists to avoid. Filtered here so it does not drown out warnings that matter.


@pytest.fixture(scope="session", autouse=True)
def setup_database():
    # Session-scoped and driven by its own loop via asyncio.run, so it stays
    # clear of pytest-asyncio's function-scoped loops (mixing them raises
    # "attached to a different loop").
    async def create() -> None:
        engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        await engine.dispose()

    async def drop() -> None:
        engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()

    asyncio.run(create())
    yield
    asyncio.run(drop())


@pytest_asyncio.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    conn = await engine.connect()
    outer = await conn.begin()
    session = AsyncSession(
        bind=conn,
        expire_on_commit=False,
        # Match SessionLocal. With autoflush on, a SELECT quietly flushes
        # pending rows and endpoints appear to see writes that production
        # would not — which is exactly how a duplicate-id crash hid here.
        autoflush=False,
        join_transaction_mode="create_savepoint",
    )
    try:
        yield session
    finally:
        await session.close()
        if outer.is_active:
            await outer.rollback()
        await conn.close()
        await engine.dispose(close=True)


@pytest_asyncio.fixture
async def client(db: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    from main import app

    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


# Background writers open their own SessionLocal (real dev DB, foreign loop);
# neuter them so tests stay hermetic. Extend the module list as endpoints grow.
@pytest.fixture(autouse=True)
def _silence_background_writers(monkeypatch):
    async def _noop(*args, **kwargs):
        return None

    for module in ("app.api.auth", "app.api.participant", "app.api.admin"):
        for name in ("log_event", "record_audit"):
            monkeypatch.setattr(f"{module}.{name}", _noop, raising=False)


# The login throttles are process-global; reset them between tests.
@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    from app.api import auth

    auth.admin_attempts.reset()
    auth.participant_attempts.reset()
    yield
    auth.admin_attempts.reset()
    auth.participant_attempts.reset()


@pytest_asyncio.fixture
async def seed_researcher(db: AsyncSession) -> Researcher:
    researcher = Researcher(
        email="researcher@a04.test",
        password_hash=hash_password("testpassword12"),
        name="Test Researcher",
    )
    db.add(researcher)
    await db.flush()
    return researcher


@pytest_asyncio.fixture
async def seed_study(db: AsyncSession, seed_researcher: Researcher) -> Study:
    study = Study(
        name="Test Study",
        description="Automated test study.",
        created_by=seed_researcher.id,
    )
    db.add(study)
    await db.flush()
    return study


@pytest_asyncio.fixture
async def seed_participant(db: AsyncSession, seed_study: Study) -> Participant:
    participant = Participant(id="T-001", study_id=seed_study.id)
    db.add(participant)
    await db.flush()
    return participant


@pytest_asyncio.fixture
async def admin_token(seed_researcher: Researcher) -> str:
    return create_access_token(
        {"sub": seed_researcher.email, "role": "admin", "ver": seed_researcher.token_version}
    )


@pytest_asyncio.fixture
async def admin_headers(admin_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {admin_token}"}


@pytest_asyncio.fixture
async def participant_token(seed_participant: Participant) -> str:
    return create_access_token({"sub": seed_participant.id, "role": "participant"})


@pytest_asyncio.fixture
async def participant_headers(participant_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {participant_token}"}
