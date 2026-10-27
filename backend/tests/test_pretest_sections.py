import csv
import io
import json
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import func, select

from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.session import Session
from app.models.video import Video
from app.services.session_script import build_steps, count_steps, pre_test_step_count


@pytest_asyncio.fixture
async def timed_run(db, seed_study, seed_participant):
    pages = [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"CK {i + 1}",
            section="CK Aufgaben",
            section_key="ck_tasks",
            order_index=i,
            intro_title="Debugging" if i == 0 else "",
            intro_body="Sie haben 7 Minuten." if i == 0 else "",
            questions=[
                {"id": f"ck_{i}", "type": "debugging", "text": "Wo?", "max": 10, "max_entries": 5}
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
        intro_title="Fachdidaktik",
        intro_body="Lesen Sie das Beispiel.",
        questions=[{"id": "pck", "type": "free_text", "text": "Was?"}],
    )
    seed_participant.status = ParticipantStatus.active
    session = Session(participant_id=seed_participant.id, current_step_index=2)
    db.add_all([*pages, pck, session])
    await db.flush()
    return pages, pck, session


async def enter(client, headers, qid, index=2, ts=1_000_000, visit_id=None):
    body = {
        "questionnaire_id": qid,
        "step_index": index,
        "visit_id": visit_id or str(uuid4()),
        "client_ts": ts,
    }
    response = await client.post(
        "/participant/session/questionnaire-visit", json=body, headers=headers
    )
    assert response.status_code == 200, response.text
    return body, response.json()


def rows(response):
    assert response.status_code == 200, response.text
    return list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))


async def test_intros_count_and_get_does_not_start_timer(
    client, db, timed_run, seed_participant, participant_headers
):
    pages, pck, _ = timed_run
    script = (await client.get("/participant/session", headers=participant_headers)).json()
    assert script["section_timing"] is None
    assert script["steps"][1]["kind"] == "section_intro"
    assert script["steps"][1]["time_limit_seconds"] == 420
    assert script["steps"][5]["section_key"] == "pck"
    assert script["steps"][5]["kind"] == "section_intro"
    count = pre_test_step_count([*pages, pck])
    assert count == 6
    assert count_steps(count, [], False) == len(await build_steps(db, seed_participant))
    assert await db.scalar(select(func.count()).select_from(SectionAttempt)) == 0


async def test_visit_retry_and_reload_preserve_deadline(client, db, timed_run, participant_headers):
    pages, _, _ = timed_run
    body, result = await enter(client, participant_headers, pages[0].id)
    retry = await client.post(
        "/participant/session/questionnaire-visit", json=body, headers=participant_headers
    )
    assert retry.status_code == 200
    assert retry.json()["section_timing"]["deadline_ms"] == result["section_timing"]["deadline_ms"]
    _, reloaded = await enter(client, participant_headers, pages[0].id, ts=1_050_000)
    assert reloaded["section_timing"]["deadline_ms"] == result["section_timing"]["deadline_ms"]
    assert await db.scalar(select(func.count()).select_from(QuestionnaireVisit)) == 2
    assert await db.scalar(select(func.count()).select_from(SectionAttempt)) == 1


async def test_skip_saves_partial_current_page_and_no_unvisited_rows(
    client, db, timed_run, participant_headers, admin_headers, seed_study
):
    pages, _, session = timed_run
    body, timer = await enter(client, participant_headers, pages[0].id)
    finish = {
        "expected_step_index": 2,
        "visit_id": body["visit_id"],
        "request_id": str(uuid4()),
        "client_ts": 1_425_000,
        "answers": {"ck_0": {"lines": [3], "explanation": ""}},
    }
    response = await client.post(
        "/participant/session/finish-ck", json=finish, headers=participant_headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["current_step_index"] == 5
    assert session.current_step_index == 5
    saved = (await db.scalars(select(QuestionnaireResponse))).all()
    assert len(saved) == 1
    assert saved[0].questionnaire_id == pages[0].id
    assert saved[0].response_status == "partial"
    assert saved[0].time_spent_seconds == 425
    visits = (await db.scalars(select(QuestionnaireVisit))).all()
    assert len(visits) == 1
    assert visits[0].exited_client_ts == 1_425_000
    retry = await client.post(
        "/participant/session/finish-ck", json=finish, headers=participant_headers
    )
    assert retry.status_code == 200
    script = (await client.get("/participant/session", headers=participant_headers)).json()
    assert script["section_timing"]["finished"] is True
    assert script["section_timing"]["deadline_ms"] == timer["section_timing"]["deadline_ms"]
    assert script["steps"][3]["skipped"] is True
    assert script["steps"][3]["completed"] is False
    exported = rows(
        await client.get(f"/admin/studies/{seed_study.id}/export/sections", headers=admin_headers)
    )
    assert len(exported) == 1
    assert float(exported[0]["elapsed_seconds"]) == 425
    assert float(exported[0]["deadline_overrun_seconds"]) == 5
    assert exported[0]["pages_answered"] == "0"
    assert exported[0]["visited_pages"] == "1"
    assert len(json.loads(exported[0]["page_visits"])) == 1
    assert exported[0]["exit_reason"] == "supervisor_finish"
    response_rows = rows(
        await client.get(f"/admin/studies/{seed_study.id}/export/responses", headers=admin_headers)
    )
    assert response_rows[0]["response_status"] == "partial"


async def test_expiry_does_not_advance_and_unfinished_visit_exports_null_exit(
    client, db, timed_run, participant_headers, admin_headers, seed_study
):
    pages, _, session = timed_run
    await enter(client, participant_headers, pages[0].id)
    attempt = await db.scalar(select(SectionAttempt))
    attempt.deadline_ms = 1
    await db.flush()
    response = (await client.get("/participant/session", headers=participant_headers)).json()
    assert response["current_step_index"] == 2
    assert response["section_timing"]["finished"] is False
    assert session.current_step_index == 2
    exported = rows(
        await client.get(f"/admin/studies/{seed_study.id}/export/sections", headers=admin_headers)
    )
    assert len(exported) == 1
    assert exported[0]["ended_client_ts"] == ""
    assert exported[0]["elapsed_seconds"] == ""
    assert json.loads(exported[0]["page_visits"])[0]["exited_client_ts"] is None


@pytest.mark.parametrize("change", ["wrong_step", "invalid_lines", "missing_pck", "before_entry"])
async def test_invalid_finish_does_not_change_data(
    change, client, db, timed_run, participant_headers
):
    pages, pck, session = timed_run
    visit, _ = await enter(client, participant_headers, pages[0].id)
    finish = {
        "expected_step_index": 2,
        "visit_id": visit["visit_id"],
        "request_id": str(uuid4()),
        "client_ts": 1_030_000,
        "answers": {},
    }
    if change == "wrong_step":
        finish["expected_step_index"] = 3
    elif change == "invalid_lines":
        finish["answers"] = {"ck_0": {"lines": [1, 2, 3, 4, 5, 6], "explanation": ""}}
    elif change == "missing_pck":
        pck.section_key = "different"
        await db.flush()
    else:
        finish["client_ts"] = 900_000
    response = await client.post(
        "/participant/session/finish-ck", json=finish, headers=participant_headers
    )
    assert response.status_code in (409, 422), response.text
    assert session.current_step_index == 2
    assert await db.scalar(select(func.count()).select_from(QuestionnaireResponse)) == 0
    stored = await db.get(QuestionnaireVisit, visit["visit_id"])
    assert stored.exited_client_ts is None


async def test_normal_finish_and_review_preserve_original_attempt(
    client, db, timed_run, participant_headers
):
    pages, _, session = timed_run
    session.current_step_index = 4
    await db.flush()
    visit, _ = await enter(client, participant_headers, pages[2].id, index=4)
    answers = {"ck_2": {"lines": [4], "explanation": "Missing semicolon"}}
    submit = {"answers": answers, "visit_id": visit["visit_id"], "client_ts": 1_030_000}
    response = await client.post(
        f"/participant/questionnaires/{pages[2].id}/respond",
        json=submit,
        headers=participant_headers,
    )
    assert response.status_code == 201, response.text
    advance = await client.patch(
        "/participant/session/progress",
        json={"current_step_index": 5, "client_ts": 1_031_000},
        headers=participant_headers,
    )
    assert advance.status_code == 200
    attempt = await db.scalar(select(SectionAttempt))
    assert attempt.ended_client_ts == 1_031_000
    assert attempt.exit_reason == "completed"
    back = await client.post("/participant/session/step-back", headers=participant_headers)
    assert back.status_code == 200
    review, _ = await enter(client, participant_headers, pages[2].id, index=4, ts=1_100_000)
    finish = {
        "expected_step_index": 4,
        "visit_id": review["visit_id"],
        "request_id": str(uuid4()),
        "client_ts": 1_120_000,
        "answers": answers,
    }
    assert (
        await client.post(
            "/participant/session/finish-ck", json=finish, headers=participant_headers
        )
    ).status_code == 200
    assert attempt.ended_client_ts == 1_031_000
    assert (await db.get(QuestionnaireVisit, review["visit_id"])).is_review is True


async def test_submit_wins_race_against_finish(client, db, timed_run, participant_headers):
    pages, _, session = timed_run
    visit, _ = await enter(client, participant_headers, pages[0].id)
    answers = {"ck_0": {"lines": [4], "explanation": "semicolon"}}
    response = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond",
        json={"answers": answers, "visit_id": visit["visit_id"], "client_ts": 1_005_000},
        headers=participant_headers,
    )
    assert response.status_code == 201
    finish = {
        "expected_step_index": 2,
        "visit_id": visit["visit_id"],
        "request_id": str(uuid4()),
        "client_ts": 1_006_000,
        "answers": {},
    }
    assert (
        await client.post(
            "/participant/session/finish-ck", json=finish, headers=participant_headers
        )
    ).status_code == 409
    assert session.current_step_index == 2
    saved = await db.scalar(select(QuestionnaireResponse))
    assert saved.answers == answers
    assert saved.response_status == "submitted"


async def test_finish_wins_race_against_old_submission(client, db, timed_run, participant_headers):
    pages, _, session = timed_run
    visit, _ = await enter(client, participant_headers, pages[0].id)
    finish = {
        "expected_step_index": 2,
        "visit_id": visit["visit_id"],
        "request_id": str(uuid4()),
        "client_ts": 1_006_000,
        "answers": {},
    }
    assert (
        await client.post(
            "/participant/session/finish-ck", json=finish, headers=participant_headers
        )
    ).status_code == 200
    late = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond",
        json={
            "answers": {"ck_0": {"lines": [4], "explanation": "late"}},
            "visit_id": visit["visit_id"],
            "client_ts": 1_005_000,
        },
        headers=participant_headers,
    )
    assert late.status_code == 409
    await client.patch(
        "/participant/session/progress", json={"current_step_index": 3}, headers=participant_headers
    )
    assert session.current_step_index == 5


async def test_step_back_closes_only_current_visit(client, db, timed_run, participant_headers):
    pages, _, _ = timed_run
    visit, _ = await enter(client, participant_headers, pages[0].id)
    response = await client.post(
        "/participant/session/step-back",
        json={"visit_id": visit["visit_id"], "client_ts": 1_020_000},
        headers=participant_headers,
    )
    assert response.status_code == 200
    stored = await db.get(QuestionnaireVisit, visit["visit_id"])
    assert stored.exit_reason == "step_back"
    assert stored.exited_client_ts == 1_020_000
    assert (await db.scalar(select(SectionAttempt))).ended_client_ts is None


async def test_started_study_allows_wording_but_blocks_structure(
    client, timed_run, admin_headers, seed_study
):
    pages, _, _ = timed_run
    q = pages[0]
    wording = await client.patch(
        f"/admin/questionnaires/{q.id}",
        json={"title": "Korrigiert", "questions": [{**q.questions[0], "text": "Welche Zeile?"}]},
        headers=admin_headers,
    )
    assert wording.status_code == 200, wording.text
    for body in (
        {"order_index": 99},
        {"section_key": "another"},
        {"questions": []},
        {"questions": [{**q.questions[0], "max": 20}]},
    ):
        assert (
            await client.patch(f"/admin/questionnaires/{q.id}", json=body, headers=admin_headers)
        ).status_code == 409
    assert (
        await client.delete(f"/admin/questionnaires/{q.id}", headers=admin_headers)
    ).status_code == 409
    assert (
        await client.post(
            f"/admin/studies/{seed_study.id}/questionnaires",
            json={"placement": "pre_test", "title": "New"},
            headers=admin_headers,
        )
    ).status_code == 409


async def test_pretest_case_intro_override_preserves_training_fallback(
    db, seed_study, seed_participant
):
    seed_study.texts = {
        "case_intro_title": "Allgemein",
        "case_intro_body": "Standard",
        "pre_test_case_intro_title": "Vortest",
        "pre_test_case_intro_body": "Nur Vortest",
    }
    db.add_all(
        [
            Video(study_id=seed_study.id, title="pre", phase_type=PhaseType.pre_test),
            Video(study_id=seed_study.id, title="train", phase_type=PhaseType.training),
        ]
    )
    await db.flush()
    intros = [
        step for step in await build_steps(db, seed_participant) if step["kind"] == "case_intro"
    ]
    assert [step["title"] for step in intros] == ["Vortest", "Allgemein"]
    assert [step["body"] for step in intros] == ["Nur Vortest", "Standard"]


async def test_finish_retry_rejects_changed_payload(client, timed_run, participant_headers):
    pages, _, _ = timed_run
    visit, _ = await enter(client, participant_headers, pages[0].id)
    finish = {
        "expected_step_index": 2,
        "visit_id": visit["visit_id"],
        "request_id": str(uuid4()),
        "client_ts": 1_006_000,
        "answers": {},
    }
    assert (
        await client.post(
            "/participant/session/finish-ck", json=finish, headers=participant_headers
        )
    ).status_code == 200
    changed = {**finish, "answers": {"ck_0": {"lines": [2], "explanation": "new"}}}
    assert (
        await client.post(
            "/participant/session/finish-ck", json=changed, headers=participant_headers
        )
    ).status_code == 409


@pytest.mark.parametrize("whole_study", [False, True])
async def test_erasure_cascades_pretest_timing(
    whole_study,
    client,
    db,
    timed_run,
    seed_participant,
    seed_study,
    participant_headers,
    admin_headers,
):
    pages, _, _ = timed_run
    await enter(client, participant_headers, pages[0].id)
    path = (
        f"/admin/studies/{seed_study.id}?force=true"
        if whole_study
        else f"/admin/participants/{seed_participant.id}"
    )
    response = await client.delete(path, headers=admin_headers)
    assert response.status_code == 200, response.text
    assert await db.scalar(select(func.count()).select_from(QuestionnaireVisit)) == 0
    assert await db.scalar(select(func.count()).select_from(SectionAttempt)) == 0


async def test_null_section_key_cannot_bypass_started_guard(client, timed_run, admin_headers):
    pages, _, _ = timed_run
    response = await client.patch(
        f"/admin/questionnaires/{pages[0].id}", json={"section_key": None}, headers=admin_headers
    )
    assert response.status_code == 409


async def test_atomic_submit_advances_once_and_survives_lost_ack(
    client, db, timed_run, participant_headers
):
    pages, _, session = timed_run
    visit, _ = await enter(client, participant_headers, pages[0].id)
    body = {
        "answers": {"ck_0": {"lines": [4], "explanation": "semicolon"}},
        "visit_id": visit["visit_id"],
        "client_ts": 1_005_000,
        "advance": True,
        "current_step_index": 999,
    }
    response = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond", json=body, headers=participant_headers
    )
    assert response.status_code == 201, response.text
    assert session.current_step_index == 3
    retry = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond", json=body, headers=participant_headers
    )
    assert retry.status_code == 201
    assert session.current_step_index == 3
    assert await db.scalar(select(func.count()).select_from(QuestionnaireResponse)) == 1
    stored = await db.get(QuestionnaireVisit, visit["visit_id"])
    assert stored.exited_client_ts == 1_005_000
    assert stored.submitted_answers == body["answers"]


async def test_atomic_submit_failure_rolls_back_answers_visit_and_pointer(
    client, db, timed_run, participant_headers, monkeypatch
):
    from sqlalchemy.exc import IntegrityError

    pages, _, session = timed_run
    qid = pages[0].id
    visit, _ = await enter(client, participant_headers, qid)
    original_commit = db.commit
    failed = False

    async def fail_once():
        nonlocal failed
        if not failed:
            failed = True
            raise IntegrityError("commit", {}, Exception("simulated failure"))
        await original_commit()

    monkeypatch.setattr(db, "commit", fail_once)
    body = {
        "answers": {"ck_0": {"lines": [4], "explanation": "semicolon"}},
        "visit_id": visit["visit_id"],
        "client_ts": 1_005_000,
        "advance": True,
    }
    failed_response = await client.post(
        f"/participant/questionnaires/{qid}/respond", json=body, headers=participant_headers
    )
    assert failed_response.status_code == 409
    await db.refresh(session)
    assert session.current_step_index == 2
    assert await db.scalar(select(func.count()).select_from(QuestionnaireResponse)) == 0
    stored = await db.get(QuestionnaireVisit, visit["visit_id"])
    assert stored.exited_client_ts is None
    assert stored.submitted_answers is None
    body["answers"]["ck_0"]["explanation"] = "corrected after failed save"
    retried = await client.post(
        f"/participant/questionnaires/{qid}/respond", json=body, headers=participant_headers
    )
    assert retried.status_code == 201, retried.text
    assert session.current_step_index == 3


async def test_atomic_last_ck_submission_closes_attempt(client, db, timed_run, participant_headers):
    pages, _, session = timed_run
    session.current_step_index = 4
    await db.flush()
    visit, _ = await enter(client, participant_headers, pages[2].id, index=4)
    body = {
        "answers": {"ck_2": {"lines": [4], "explanation": "semicolon"}},
        "visit_id": visit["visit_id"],
        "client_ts": 1_005_000,
        "advance": True,
    }
    response = await client.post(
        f"/participant/questionnaires/{pages[2].id}/respond", json=body, headers=participant_headers
    )
    assert response.status_code == 201, response.text
    assert session.current_step_index == 5
    attempt = await db.scalar(select(SectionAttempt))
    assert attempt.ended_client_ts == 1_005_000
    assert attempt.exit_reason == "completed"


async def test_section_submission_cannot_bypass_visit_identity(
    client, db, timed_run, participant_headers
):
    pages, _, _ = timed_run
    visit, _ = await enter(client, participant_headers, pages[0].id)
    finish = {
        "expected_step_index": 2,
        "visit_id": visit["visit_id"],
        "request_id": str(uuid4()),
        "client_ts": 1_006_000,
        "answers": {},
    }
    assert (
        await client.post(
            "/participant/session/finish-ck", json=finish, headers=participant_headers
        )
    ).status_code == 200
    late = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond",
        json={"answers": {"ck_0": {"lines": [4], "explanation": "late"}}},
        headers=participant_headers,
    )
    assert late.status_code == 422
    saved = await db.scalar(select(QuestionnaireResponse))
    assert saved.answers == {}
    assert saved.response_status == "partial"


async def test_progress_expected_source_accepts_retry_and_rejects_stale_advance(
    client, timed_run, participant_headers
):
    _, _, session = timed_run
    first = {"expected_step_index": 2, "current_step_index": 3}
    assert (
        await client.patch("/participant/session/progress", json=first, headers=participant_headers)
    ).status_code == 200
    assert (
        await client.patch("/participant/session/progress", json=first, headers=participant_headers)
    ).status_code == 200
    assert session.current_step_index == 3
    stale = {"expected_step_index": 2, "current_step_index": 4}
    assert (
        await client.patch("/participant/session/progress", json=stale, headers=participant_headers)
    ).status_code == 409
    assert session.current_step_index == 3


async def test_pck_visit_without_response_is_exported(
    client, db, timed_run, participant_headers, admin_headers, seed_study
):
    _, pck, session = timed_run
    session.current_step_index = 6
    await db.flush()
    visit, _ = await enter(client, participant_headers, pck.id, index=6)
    exported = rows(
        await client.get(f"/admin/studies/{seed_study.id}/export/sections", headers=admin_headers)
    )
    assert len(exported) == 1
    assert exported[0]["section_key"] == "pck"
    assert exported[0]["pages_answered"] == "0"
    assert exported[0]["visited_pages"] == "1"
    assert exported[0]["started_client_ts"] == ""
    assert exported[0]["elapsed_seconds"] == ""
    assert json.loads(exported[0]["page_visits"])[0]["visit_id"] == visit["visit_id"]
    counts = (
        await client.get(f"/admin/studies/{seed_study.id}/exports", headers=admin_headers)
    ).json()
    assert next(item["rows"] for item in counts if item["kind"] == "sections") == 1
