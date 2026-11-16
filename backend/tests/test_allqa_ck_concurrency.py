"""Actual competing transactions, rather than sequential race simulations."""

import asyncio
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import participant as participant_api
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.enums import ParticipantStatus, QuestionnairePlacement
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.session import Session
from app.models.study import Study
from main import app
from tests.conftest import TEST_DATABASE_URL


@pytest.mark.parametrize("first", ["submit", "finish"])
async def test_ck_submit_and_finish_are_atomic_under_competing_transactions(monkeypatch, first):
    engine = create_async_engine(TEST_DATABASE_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    pid = f"QA-RACE-{uuid4().hex}"
    async with factory() as db:
        study = Study(name="Concurrent CK QA", flow_version="pilot_20261116")
        db.add(study)
        await db.flush()
        participant = Participant(id=pid, study_id=study.id, status=ParticipantStatus.active)
        pages = [
            Questionnaire(
                study_id=study.id,
                placement=QuestionnairePlacement.pre_test,
                title=key,
                section_key=key,
                order_index=index,
                questions=[{"id": key, "type": "free_text", "text": "Answer", "required": True}],
            )
            for index, key in enumerate(("ck_tasks", "pck"))
        ]
        db.add_all([participant, *pages])
        await db.flush()
        db.add(Session(participant_id=pid, current_step_index=1))
        await db.commit()

    async def isolated_db():
        async with factory() as db:
            yield db

    prior_overrides = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = isolated_db
    headers = {
        "Authorization": f"Bearer {create_access_token({'sub': pid, 'role': 'participant'})}"
    }
    visit_id = str(uuid4())
    rendezvous = asyncio.Event()
    arrivals = 0
    original_lock = participant_api.lock_session

    async def competing_lock(db, participant_id):
        nonlocal arrivals
        arrivals += 1
        if arrivals == 2:
            rendezvous.set()
        await asyncio.wait_for(rendezvous.wait(), timeout=5)
        if asyncio.current_task().get_name() != first:
            await asyncio.sleep(0.05)
        return await original_lock(db, participant_id)

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            entered = await client.post(
                "/participant/session/questionnaire-visit",
                headers=headers,
                json={
                    "step_index": 1,
                    "questionnaire_id": pages[0].id,
                    "visit_id": visit_id,
                    "client_ts": 1_000_000,
                },
            )
            assert entered.status_code == 200, entered.text
            monkeypatch.setattr(participant_api, "lock_session", competing_lock)
            submitted, finished = await asyncio.wait_for(
                asyncio.gather(
                    asyncio.create_task(
                        client.post(
                            f"/participant/questionnaires/{pages[0].id}/respond",
                            headers=headers,
                            json={
                                "visit_id": visit_id,
                                "client_ts": 1_020_000,
                                "answers": {"ck_tasks": "Full answer"},
                                "advance": True,
                            },
                        ),
                        name="submit",
                    ),
                    asyncio.create_task(
                        client.post(
                            "/participant/session/finish-ck",
                            headers=headers,
                            json={
                                "visit_id": visit_id,
                                "request_id": str(uuid4()),
                                "expected_step_index": 1,
                                "client_ts": 1_030_000,
                                "answers": {"ck_tasks": "Partial draft"},
                                "reason": "supervisor",
                            },
                        ),
                        name="finish",
                    ),
                ),
                timeout=10,
            )
        statuses = [submitted.status_code, finished.status_code]
        assert statuses == ([201, 409] if first == "submit" else [409, 200]), statuses
        async with factory() as db:
            session = await db.scalar(select(Session).where(Session.participant_id == pid))
            attempt = await db.scalar(
                select(SectionAttempt).where(SectionAttempt.participant_id == pid)
            )
            visit = await db.get(QuestionnaireVisit, visit_id)
            answers = list(
                (
                    await db.scalars(
                        select(QuestionnaireResponse).where(
                            QuestionnaireResponse.participant_id == pid
                        )
                    )
                ).all()
            )
            assert session.current_step_index == 2
            assert session.current_questionnaire_visit_id is None
            assert len(answers) == 1
            assert answers[0].answers == {
                "ck_tasks": "Full answer" if first == "submit" else "Partial draft"
            }
            assert answers[0].response_status == ("submitted" if first == "submit" else "partial")
            assert visit.exit_reason == ("submitted" if first == "submit" else "supervisor_finish")
            assert attempt.exit_reason == (
                "completed" if first == "submit" else "supervisor_finish"
            )
            assert visit.exited_client_ts == attempt.ended_client_ts
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(prior_overrides)
        async with factory() as db:
            await db.execute(delete(Participant).where(Participant.id == pid))
            await db.execute(delete(Study).where(Study.id == study.id))
            await db.commit()
        await engine.dispose()
