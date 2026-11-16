import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import func, select

from app.core.database import Base
from app.models.enums import ParticipantStatus, QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.session import Session
from app.services.session_script import build_steps


@pytest_asyncio.fixture
async def ck_run(request, db, seed_study, seed_participant):
    seed_study.flow_version = getattr(request, "param", "pilot_20261116")
    seed_study.think_aloud_mode = (
        "bundled" if seed_study.flow_version == "pilot_20261116" else "block"
    )
    pages = [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"CK {i}",
            section="CK",
            section_key="ck_tasks",
            order_index=i,
            intro_title="CK Intro" if i == 0 else "",
            intro_body="Anleitung" if i == 0 else "",
            questions=[
                {"id": f"ck_{i}", "type": "debugging", "text": "Wo?", "max": 10, "allow_skip": True}
            ],
        )
        for i in range(3)
    ]
    pck = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="PCK",
        section="PCK",
        section_key="pck",
        order_index=3,
        intro_title="PCK Intro",
        intro_body="Anleitung",
        questions=[{"id": "pck", "type": "free_text", "text": "Warum?"}],
    )
    seed_participant.status = ParticipantStatus.active
    session = Session(participant_id=seed_participant.id, current_step_index=2)
    db.add_all([*pages, pck, session])
    await db.flush()
    steps = await build_steps(db, seed_participant)
    assert steps[2]["questionnaire_id"] == pages[0].id
    assert steps[5]["kind"] == "section_intro" and steps[5]["section_key"] == "pck"
    return pages, session, steps


async def enter(client, headers, page, *, index=2, ts=1_000_000):
    visit_id = str(uuid4())
    response = await client.post(
        "/participant/session/questionnaire-visit",
        headers=headers,
        json={
            "questionnaire_id": page.id,
            "step_index": index,
            "visit_id": visit_id,
            "client_ts": ts,
        },
    )
    assert response.status_code == 200, response.text
    return visit_id


async def submit(client, headers, page, visit_id, *, advance=False, skipped=False):
    question_id = page.questions[0]["id"]
    answers = {
        question_id: (
            {"lines": [0], "explanation": "", "skipped": True}
            if skipped
            else {"lines": [3], "explanation": "Fehlendes Semikolon"}
        )
    }
    response = await client.post(
        f"/participant/questionnaires/{page.id}/respond",
        headers=headers,
        json={
            "answers": answers,
            "visit_id": visit_id,
            "client_ts": 1_020_000,
            "advance": advance,
        },
    )
    assert response.status_code == 201, response.text
    return answers


@pytest.mark.parametrize("ck_run", ["legacy", "pilot_20261116"], indirect=True)
@pytest.mark.parametrize("target", [3, 5, "thanks", "past_end"])
@pytest.mark.parametrize("client_ts", [None, 1_100_000])
async def test_generic_progress_cannot_leave_an_unsaved_ck_visit(
    client, db, ck_run, participant_headers, target, client_ts
):
    pages, session, steps = ck_run
    visit_id = await enter(client, participant_headers, pages[0])
    target = (
        len(steps) - 1
        if target == "thanks"
        else len(steps) + 10
        if target == "past_end"
        else target
    )
    body = {"current_step_index": target, "expected_step_index": 2}
    if client_ts is not None:
        body["client_ts"] = client_ts
    response = await client.patch(
        "/participant/session/progress", headers=participant_headers, json=body
    )
    assert response.status_code == 409, response.text
    assert session.current_step_index == 2
    assert session.completed_at is None
    assert (await db.get(QuestionnaireVisit, visit_id)).exited_client_ts is None
    assert (await db.scalar(select(SectionAttempt))).ended_client_ts is None
    assert await db.scalar(select(func.count()).select_from(QuestionnaireResponse)) == 0


async def test_generic_progress_requires_a_visit_and_cannot_skip_ck_from_the_intro(
    client, db, ck_run, participant_headers
):
    _, session, _ = ck_run
    for origin, target in [(2, 3), (1, 5), (0, 5)]:
        session.current_step_index = origin
        await db.flush()
        response = await client.patch(
            "/participant/session/progress",
            headers=participant_headers,
            json={"current_step_index": target},
        )
        assert response.status_code == 409, response.text
        assert session.current_step_index == origin
    for target in (1, 2):
        response = await client.patch(
            "/participant/session/progress",
            headers=participant_headers,
            json={"current_step_index": target},
        )
        assert response.status_code == 200, response.text
        assert session.current_step_index == target
    assert await db.scalar(select(func.count()).select_from(SectionAttempt)) == 0


@pytest.mark.parametrize("skipped", [False, True])
@pytest.mark.parametrize("current_ts", [990_000, 1_000_000, 1_010_000])
async def test_saved_current_visit_can_advance_one_page_after_a_reload(
    client, db, ck_run, participant_headers, skipped, current_ts
):
    pages, session, _ = ck_run
    old_visit = await enter(client, participant_headers, pages[0])
    current_visit = await enter(client, participant_headers, pages[0], ts=current_ts)
    answers = await submit(client, participant_headers, pages[0], current_visit, skipped=skipped)
    response = await client.patch(
        "/participant/session/progress",
        headers=participant_headers,
        json={"current_step_index": 3, "expected_step_index": 2},
    )
    assert response.status_code == 200, response.text
    assert session.current_step_index == 3
    assert session.current_questionnaire_visit_id is None
    assert (await db.get(QuestionnaireVisit, old_visit)).exited_client_ts is None
    assert (await db.get(QuestionnaireVisit, current_visit)).exit_reason == "submitted"
    assert (await db.scalar(select(QuestionnaireResponse))).answers == answers
    assert (await db.scalar(select(SectionAttempt))).ended_client_ts is None


async def test_saved_ck_page_cannot_authorize_skipping_later_ck_pages(
    client, db, ck_run, participant_headers
):
    pages, session, _ = ck_run
    visit_id = await enter(client, participant_headers, pages[0])
    await submit(client, participant_headers, pages[0], visit_id)
    response = await client.patch(
        "/participant/session/progress",
        headers=participant_headers,
        json={"current_step_index": 5, "client_ts": 1_030_000},
    )
    assert response.status_code == 409, response.text
    assert session.current_step_index == 2
    assert (await db.scalar(select(SectionAttempt))).ended_client_ts is None


@pytest.mark.parametrize("expired", [False, True])
@pytest.mark.parametrize("current_ts", [990_000, 1_000_000, 1_030_000])
async def test_old_submitted_answer_does_not_authorize_an_active_new_visit(
    client, db, ck_run, participant_headers, expired, current_ts
):
    pages, session, _ = ck_run
    old_visit = await enter(client, participant_headers, pages[0])
    saved = await submit(client, participant_headers, pages[0], old_visit)
    current_visit = await enter(client, participant_headers, pages[0], ts=current_ts)
    attempt = await db.scalar(select(SectionAttempt))
    if expired:
        attempt.deadline_ms = 1
        await db.flush()
    response = await client.patch(
        "/participant/session/progress",
        headers=participant_headers,
        json={"current_step_index": 3, "client_ts": 1_040_000},
    )
    assert response.status_code == 409, response.text
    assert session.current_step_index == 2
    assert session.current_questionnaire_visit_id == current_visit
    assert (await db.get(QuestionnaireVisit, current_visit)).exited_client_ts is None
    assert (await db.scalar(select(QuestionnaireResponse))).answers == saved
    assert attempt.ended_client_ts is None


async def test_last_ck_submission_can_finish_after_deadline_without_double_advancing(
    client, db, ck_run, participant_headers
):
    pages, session, _ = ck_run
    session.current_step_index = 4
    await db.flush()
    visit_id = await enter(client, participant_headers, pages[2], index=4)
    await submit(client, participant_headers, pages[2], visit_id)
    attempt = await db.scalar(select(SectionAttempt))
    attempt.deadline_ms = 1
    await db.flush()
    body = {"current_step_index": 5, "expected_step_index": 4}
    for _ in range(2):
        response = await client.patch(
            "/participant/session/progress", headers=participant_headers, json=body
        )
        assert response.status_code == 200, response.text
        assert session.current_step_index == 5
        assert attempt.exit_reason == "completed"
        assert attempt.ended_client_ts == 1_020_000
    # The next intro is an ordinary navigation step again.
    response = await client.patch(
        "/participant/session/progress",
        headers=participant_headers,
        json={"current_step_index": 6, "expected_step_index": 5},
    )
    assert response.status_code == 200, response.text


async def test_atomic_ck_submission_and_stale_progress_ack_remain_idempotent(
    client, ck_run, participant_headers
):
    pages, session, _ = ck_run
    visit_id = await enter(client, participant_headers, pages[0])
    await submit(client, participant_headers, pages[0], visit_id, advance=True)
    current_visit = await enter(client, participant_headers, pages[1], index=3, ts=990_000)
    await submit(client, participant_headers, pages[0], visit_id, advance=True)
    response = await client.patch(
        "/participant/session/progress",
        headers=participant_headers,
        json={"current_step_index": 3, "expected_step_index": 2},
    )
    assert response.status_code == 200, response.text
    assert session.current_step_index == 3
    assert session.current_questionnaire_visit_id == current_visit


async def test_step_back_visit_is_not_a_submission_but_intro_navigation_still_works(
    client, ck_run, participant_headers
):
    pages, session, _ = ck_run
    visit_id = await enter(client, participant_headers, pages[0])
    back = await client.post(
        "/participant/session/step-back",
        headers=participant_headers,
        json={"visit_id": visit_id, "client_ts": 1_010_000},
    )
    assert back.status_code == 200, back.text
    assert session.current_step_index == 1
    assert session.current_questionnaire_visit_id is None
    into_ck = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 2}
    )
    assert into_ck.status_code == 200, into_ck.text
    leave_ck = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 3}
    )
    assert leave_ck.status_code == 409, leave_ck.text
    assert session.current_step_index == 2


@pytest.mark.parametrize("reason", ["supervisor", "timer_expired"])
async def test_section_finish_still_saves_and_closes_the_blocked_ck_page(
    client, db, ck_run, participant_headers, reason
):
    pages, session, _ = ck_run
    visit_id = await enter(client, participant_headers, pages[0])
    attempt = await db.scalar(select(SectionAttempt))
    if reason == "timer_expired":
        attempt.deadline_ms = 1
        await db.flush()
    bypass = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 5}
    )
    assert bypass.status_code == 409
    finish = await client.post(
        "/participant/session/finish-ck",
        headers=participant_headers,
        json={
            "expected_step_index": 2,
            "visit_id": visit_id,
            "request_id": str(uuid4()),
            "client_ts": 1_030_000,
            "reason": reason,
            "answers": {"ck_0": {"lines": [3], "explanation": "Entwurf"}},
        },
    )
    assert finish.status_code == 200, finish.text
    assert session.current_step_index == 5
    assert session.current_questionnaire_visit_id is None
    assert (await db.scalar(select(QuestionnaireResponse))).response_status == "partial"
    assert (await db.get(QuestionnaireVisit, visit_id)).exited_client_ts == 1_030_000
    assert attempt.ended_client_ts == 1_030_000


async def test_old_enter_and_submit_retries_cannot_reclaim_a_new_visit(
    client, ck_run, participant_headers
):
    pages, session, _ = ck_run
    old_visit = await enter(client, participant_headers, pages[0])
    await submit(client, participant_headers, pages[0], old_visit)
    current_visit = await enter(client, participant_headers, pages[0], ts=990_000)
    retry = await client.post(
        "/participant/session/questionnaire-visit",
        headers=participant_headers,
        json={
            "questionnaire_id": pages[0].id,
            "step_index": 2,
            "visit_id": old_visit,
            "client_ts": 1_000_000,
        },
    )
    assert retry.status_code == 200, retry.text
    await submit(client, participant_headers, pages[0], old_visit)
    assert session.current_questionnaire_visit_id == current_visit
    response = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 3}
    )
    assert response.status_code == 409, response.text


@pytest.mark.parametrize("action", ["submit", "finish", "back"])
async def test_an_older_open_visit_cannot_mutate_the_current_visit(
    client, db, ck_run, participant_headers, action
):
    pages, session, _ = ck_run
    old_visit = await enter(client, participant_headers, pages[0])
    current_visit = await enter(client, participant_headers, pages[0], ts=990_000)
    body = {"visit_id": old_visit, "client_ts": 1_020_000}
    if action == "submit":
        url = f"/participant/questionnaires/{pages[0].id}/respond"
        body.update(answers={"ck_0": {"lines": [3], "explanation": "Stale"}}, advance=True)
    elif action == "finish":
        url = "/participant/session/finish-ck"
        body.update(expected_step_index=2, request_id=str(uuid4()), reason="supervisor", answers={})
    else:
        url = "/participant/session/step-back"
    response = await client.post(url, headers=participant_headers, json=body)
    assert response.status_code == 409, response.text
    assert session.current_step_index == 2
    assert session.current_questionnaire_visit_id == current_visit
    assert (await db.get(QuestionnaireVisit, old_visit)).exited_client_ts is None
    assert await db.scalar(select(func.count()).select_from(QuestionnaireResponse)) == 0


async def test_returning_to_a_submitted_page_requires_a_new_visit(
    client, ck_run, participant_headers
):
    pages, session, _ = ck_run
    visit_id = await enter(client, participant_headers, pages[0])
    await submit(client, participant_headers, pages[0], visit_id)
    back = await client.post("/participant/session/step-back", headers=participant_headers)
    assert back.status_code == 200, back.text
    assert session.current_questionnaire_visit_id is None
    into_ck = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 2}
    )
    assert into_ck.status_code == 200, into_ck.text
    retry = await client.post(
        "/participant/session/questionnaire-visit",
        headers=participant_headers,
        json={
            "questionnaire_id": pages[0].id,
            "step_index": 2,
            "visit_id": visit_id,
            "client_ts": 1_000_000,
        },
    )
    assert retry.status_code == 200, retry.text
    assert session.current_questionnaire_visit_id is None
    response = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 3}
    )
    assert response.status_code == 409, response.text


@pytest.mark.parametrize("advance", [False, True])
async def test_migration_preserves_ambiguous_visits_without_guessing_the_current_one(
    client, db, ck_run, participant_headers, advance
):
    pages, session, _ = ck_run
    old_visit = await enter(client, participant_headers, pages[0])
    await submit(client, participant_headers, pages[0], old_visit)
    active_visit = await enter(client, participant_headers, pages[0], ts=990_000)
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic/versions/b2e4f6a8c0d3_current_questionnaire_visit.py"
    )
    spec = importlib.util.spec_from_file_location("current_visit_migration", path)
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
    await db.refresh(session)
    assert session.current_step_index == 2
    assert session.current_questionnaire_visit_id is None
    visits = (
        await db.execute(
            select(
                QuestionnaireVisit.id,
                QuestionnaireVisit.entered_client_ts,
                QuestionnaireVisit.exited_client_ts,
                QuestionnaireVisit.exit_reason,
            )
        )
    ).all()
    assert set(visits) == {
        (old_visit, 1_000_000, 1_020_000, "submitted"),
        (active_visit, 990_000, None, None),
    }
    await submit(client, participant_headers, pages[0], active_visit, advance=advance)
    if advance:
        assert session.current_step_index == 3
        return
    blocked = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 3}
    )
    assert blocked.status_code == 409, blocked.text
    assert session.current_step_index == 2
    reloaded_visit = await enter(client, participant_headers, pages[0], ts=980_000)
    await submit(client, participant_headers, pages[0], reloaded_visit)
    continued = await client.patch(
        "/participant/session/progress", headers=participant_headers, json={"current_step_index": 3}
    )
    assert continued.status_code == 200, continued.text
    assert session.current_step_index == 3
