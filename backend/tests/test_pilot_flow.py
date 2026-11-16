from __future__ import annotations

import csv
import io
import json
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core.config import get_settings
from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.session import Session
from app.models.video import Video
from app.services.questionnaires import (
    invalid_partial_answers,
    missing_required_answers,
    valid_debugging_answer,
    validate_question_definitions,
)
from app.services.session_script import PILOT_FLOW, build_steps, count_steps
from app.services.study_content import seed_batteries


@pytest_asyncio.fixture
async def pilot_study(db, seed_study):
    seed_study.flow_version = PILOT_FLOW
    seed_study.think_aloud_mode = "bundled"
    seed_study.think_aloud_count = 3
    await db.flush()
    return seed_study


async def add_cases(db, study, count=7):
    phases = [PhaseType.pre_test] + [PhaseType.training] * (count - 2) + [PhaseType.post_test]
    videos = [
        Video(study_id=study.id, title=f"SECRET stimulus {i}", phase_type=phase)
        for i, phase in enumerate(phases if count else [])
    ]
    db.add_all(videos)
    await db.flush()
    return videos


def page_name(step):
    kind = step["kind"]
    if kind in {"section_intro", "questionnaire"}:
        return f"{kind}: {step['title']}"
    if kind == "text_page":
        return step["key"]
    if kind == "sosci":
        return f"sosci: {step['variant']}"
    if kind in {"case_intro", "case_video", "diagnosis", "case_outro", "think_aloud"}:
        return f"{kind}: {step['case_number']}"
    return kind


async def test_exact_pilot_pages_five_training_pre_post_last_three(
    db, pilot_study, seed_participant, monkeypatch
):
    monkeypatch.setattr(get_settings(), "CALIBRATION_ENABLED", False)
    await seed_batteries(db, pilot_study.id)
    await add_cases(db, pilot_study)
    steps = await build_steps(db, seed_participant)
    expected = [
        "welcome",
        "questionnaire: Angaben zur Person",
        "questionnaire: Fachwissen Programmierung",
        "questionnaire: Fachwissen Debugging",
        "section_intro: Debugging-Aufgaben",
        *[f"questionnaire: CK: Aufgabe {i}" for i in range(1, 14)],
        "section_intro: Fachdidaktisches Wissen",
        "questionnaire: Fachdidaktisches Wissen",
        "questionnaire: Fachdidaktisches Wissen",
        "questionnaire: Fachdidaktisches Wissen",
        "section_intro: MESP",
        *[f"questionnaire: MESP: Aufgabe {i}" for i in range(1, 7)],
        "sosci: pretest",
        "questionnaire_end",
        "video_start",
        "video_intro",
        *[
            f"{kind}: {i}"
            for i in range(1, 8)
            for kind in ("case_intro", "case_video", "diagnosis", "case_outro")
        ],
        "video_end",
        "discussion_start",
        "think_aloud: 5",
        "think_aloud: 6",
        "think_aloud: 7",
        "post_intro",
        "sosci: posttest",
        "thanks",
    ]
    assert [page_name(step) for step in steps] == expected
    assert [
        step["questions"][0]["id"]
        for step in steps
        if step["kind"] == "questionnaire" and step.get("section_key") == "pck"
    ] == ["pck_pre_1a", "pck_pre_3a_1", "pck_pre_5a"]
    assert len(steps) == 69
    assert "SECRET stimulus" not in json.dumps(steps)
    assert all(step["case_total"] == 7 for step in steps if "case_number" in step)


@pytest.mark.parametrize("mode", ["block", "bundled"])
@pytest.mark.parametrize("calibration", [False, True])
@pytest.mark.parametrize("case_count,narrations", [(0, 3), (7, 1), (7, 3), (7, 20)])
async def test_pilot_count_matches_script(
    db, pilot_study, seed_participant, monkeypatch, mode, calibration, case_count, narrations
):
    monkeypatch.setattr(get_settings(), "CALIBRATION_ENABLED", calibration)
    pilot_study.think_aloud_mode = mode
    pilot_study.think_aloud_count = narrations
    pilot_study.think_aloud_batch_size = 3
    videos = await add_cases(db, pilot_study, case_count)
    script = await build_steps(db, seed_participant)
    assert count_steps(
        0,
        [v.phase_type for v in videos],
        calibration,
        flow_version=PILOT_FLOW,
        think_aloud_mode=mode,
        think_aloud_count=narrations,
    ) == len(script)
    assert sum(s["kind"] == "think_aloud" for s in script) == (
        min(case_count, narrations) if mode == "bundled" else case_count
    )
    assert not any(s["kind"] == "phase_transition" for s in script)
    assert any(s.get("key") == "discussion_start" for s in script) == (mode == "bundled")


async def test_first_login_pins_pilot_settings_and_exports_them(
    client, db, pilot_study, seed_participant, admin_headers
):
    await add_cases(db, pilot_study)
    login = await client.post(
        "/auth/participant/login", json={"participant_id": seed_participant.id}
    )
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    before = (await client.get("/participant/session", headers=headers)).json()
    pilot_study.flow_version = "legacy"
    pilot_study.think_aloud_mode = "block"
    pilot_study.think_aloud_count = 1
    await db.flush()
    await client.post("/auth/participant/login", json={"participant_id": seed_participant.id})
    after = (await client.get("/participant/session", headers=headers)).json()
    assert before == after
    assert after["flow_version"] == PILOT_FLOW
    exported = await client.get(
        f"/admin/studies/{pilot_study.id}/export/participants", headers=admin_headers
    )
    rows = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
    assert rows[0]["flow_version"] == PILOT_FLOW
    assert rows[0]["think_aloud_mode"] == "bundled"
    assert rows[0]["think_aloud_count"] == "3"


async def test_new_studies_default_to_pilot_and_legacy_rejects_bundled(
    client, admin_headers, seed_study
):
    created = await client.post("/admin/studies", json={"name": "Pilot"}, headers=admin_headers)
    assert created.status_code == 201, created.text
    assert created.json()["flow_version"] == PILOT_FLOW
    assert created.json()["think_aloud_mode"] == "bundled"
    assert created.json()["think_aloud_count"] == 3
    rejected = await client.patch(
        f"/admin/studies/{seed_study.id}",
        json={"think_aloud_mode": "bundled"},
        headers=admin_headers,
    )
    assert rejected.status_code == 422


@pytest_asyncio.fixture
async def timed_pilot(db, pilot_study, seed_participant):
    pages = [
        Questionnaire(
            study_id=pilot_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"CK {i}",
            section="CK",
            section_key="ck_tasks",
            order_index=i,
            questions=[
                {"id": f"ck_{i}", "type": "debugging", "text": "Wo?", "max": 10, "allow_skip": True}
            ],
        )
        for i in range(2)
    ]
    pck = Questionnaire(
        study_id=pilot_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="PCK",
        section="PCK",
        section_key="pck",
        order_index=2,
        intro_title="PCK Intro",
        intro_body="Lesen Sie.",
        questions=[{"id": "pck", "type": "free_text", "text": "Was?"}],
    )
    seed_participant.status = ParticipantStatus.active
    session = Session(participant_id=seed_participant.id, current_step_index=1)
    db.add_all([*pages, pck, session])
    await db.flush()
    return pages, session


async def enter_ck(client, headers, page):
    visit = str(uuid4())
    response = await client.post(
        "/participant/session/questionnaire-visit",
        headers=headers,
        json={
            "questionnaire_id": page.id,
            "step_index": 1,
            "visit_id": visit,
            "client_ts": 1_000_000,
        },
    )
    assert response.status_code == 200, response.text
    return visit


async def test_ck_explicit_skip_persists_zero_empty_and_skip_status(
    client, db, timed_pilot, participant_headers, admin_headers, pilot_study
):
    pages, session = timed_pilot
    visit = await enter_ck(client, participant_headers, pages[0])
    answers = {"ck_0": {"lines": [0], "explanation": "", "skipped": True}}
    response = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond",
        headers=participant_headers,
        json={
            "visit_id": visit,
            "client_ts": 1_010_000,
            "answers": answers,
            "advance": True,
        },
    )
    assert response.status_code == 201, response.text
    assert session.current_step_index == 2
    saved = await db.scalar(select(QuestionnaireResponse))
    assert saved.answers == answers
    assert saved.response_status == "skipped"
    script = (await client.get("/participant/session", headers=participant_headers)).json()
    assert script["steps"][1]["skipped"] is True
    exported = await client.get(
        f"/admin/studies/{pilot_study.id}/export/responses", headers=admin_headers
    )
    rows = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
    assert rows[0]["response_status"] == "skipped"
    assert json.loads(rows[0]["answers"]) == answers


async def test_ck_expiry_checks_server_deadline_saves_partial_and_is_idempotent(
    client, db, timed_pilot, participant_headers
):
    pages, session = timed_pilot
    visit = await enter_ck(client, participant_headers, pages[0])
    body = {
        "reason": "timer_expired",
        "expected_step_index": 1,
        "visit_id": visit,
        "request_id": str(uuid4()),
        "client_ts": 1_420_000,
        "answers": {"ck_0": {"lines": [3, 999, None], "explanation": "unfinished"}},
    }
    early = await client.post(
        "/participant/session/finish-ck", headers=participant_headers, json=body
    )
    assert early.status_code == 409
    assert session.current_step_index == 1
    attempt = await db.scalar(select(SectionAttempt))
    attempt.deadline_ms = 1
    await db.flush()
    finished = await client.post(
        "/participant/session/finish-ck", headers=participant_headers, json=body
    )
    assert finished.status_code == 200, finished.text
    assert session.current_step_index == 3
    saved = (await db.scalars(select(QuestionnaireResponse))).all()
    assert len(saved) == 1
    assert saved[0].answers == {"ck_0": {"lines": [3, None, None], "explanation": "unfinished"}}
    assert saved[0].response_status == "partial"
    assert attempt.exit_reason == "timer_expired"
    retried = await client.post(
        "/participant/session/finish-ck", headers=participant_headers, json=body
    )
    assert retried.status_code == 200
    changed_reason = await client.post(
        "/participant/session/finish-ck",
        headers=participant_headers,
        json={**body, "reason": "supervisor"},
    )
    assert changed_reason.status_code == 409
    late_submit = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond",
        headers=participant_headers,
        json={
            "visit_id": visit,
            "client_ts": 1_420_000,
            "advance": True,
            "answers": {"ck_0": {"lines": [3], "explanation": "late edit"}},
        },
    )
    assert late_submit.status_code == 409
    assert session.current_step_index == 3
    await db.refresh(saved[0])
    assert saved[0].answers["ck_0"]["explanation"] == "unfinished"


@pytest.mark.parametrize(
    "answer",
    [
        {"lines": [0], "explanation": ""},
        {"lines": [0, 1], "explanation": "", "skipped": True},
        {"lines": [0], "explanation": "-", "skipped": True},
        {"lines": [False], "explanation": "", "skipped": True},
    ],
)
def test_skip_is_a_strict_explicit_state(answer):
    question = {"type": "debugging", "allow_skip": True}
    assert not valid_debugging_answer(question, answer)
    assert not valid_debugging_answer(question, answer, partial=True)
    assert not valid_debugging_answer(
        {"type": "debugging"}, {"lines": [0], "explanation": "", "skipped": True}
    )


def test_exact_two_requires_two_distinct_options_and_justification():
    questions = [
        {
            "id": "pick",
            "type": "multi_select",
            "text": "Choose two",
            "options": ["a", "b", "c", "d"],
            "min_selections": 2,
            "max_selections": 2,
        },
        {"id": "why", "type": "free_text", "text": "Why?", "required": True},
    ]
    assert validate_question_definitions(questions) == []
    assert missing_required_answers(questions, {"pick": ["a", "b"], "why": "Because"}) == []
    for selections in ([], ["a"], ["a", "a"], ["a", "b", "c"], ["a", "invalid"]):
        assert "pick" in missing_required_answers(questions, {"pick": selections, "why": "Because"})
    assert missing_required_answers(questions, {"pick": ["a", "b"], "why": ""}) == ["why"]
    assert invalid_partial_answers(questions, {"pick": ["a"]}) == []
    assert invalid_partial_answers(questions, {"pick": ["a", "b", "c"]}) == ["pick"]
    assert validate_question_definitions([{**questions[0], "min_selections": 3}])
    assert validate_question_definitions([{**questions[0], "max_selections": 5}])


@pytest.mark.parametrize("skip", [False, True])
@pytest.mark.parametrize("server_time", [100, 101])
async def test_expired_ck_submit_never_advances_before_partial_finish(
    client, db, timed_pilot, participant_headers, monkeypatch, skip, server_time
):
    pages, session = timed_pilot
    visit_id = await enter_ck(client, participant_headers, pages[0])
    attempt = await db.scalar(select(SectionAttempt))
    attempt.deadline_ms = 100
    await db.flush()
    monkeypatch.setattr("app.api.participant.now_ms", lambda: server_time)
    answers = {
        "ck_0": {"lines": [0], "explanation": "", "skipped": True}
        if skip
        else {"lines": [3], "explanation": "Current answer"}
    }
    response = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond",
        headers=participant_headers,
        json={"visit_id": visit_id, "client_ts": 1_001_000, "answers": answers, "advance": True},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ck_deadline_expired"
    assert session.current_step_index == 1
    assert await db.scalar(select(QuestionnaireResponse)) is None
    visit = await db.get(QuestionnaireVisit, visit_id)
    assert visit.exited_client_ts is None
    finished = await client.post(
        "/participant/session/finish-ck",
        headers=participant_headers,
        json={
            "reason": "timer_expired",
            "expected_step_index": 1,
            "visit_id": visit_id,
            "request_id": str(uuid4()),
            "client_ts": 1_420_000,
            "answers": answers,
        },
    )
    assert finished.status_code == 200, finished.text
    assert session.current_step_index == 3
    saved = (await db.scalars(select(QuestionnaireResponse))).all()
    assert len(saved) == 1
    assert saved[0].questionnaire_id == pages[0].id
    assert saved[0].answers == answers
    assert saved[0].response_status == "partial"


@pytest.mark.parametrize("skip", [False, True])
async def test_successful_ck_submission_retry_is_accepted_after_deadline(
    client, db, timed_pilot, participant_headers, skip
):
    pages, session = timed_pilot
    visit_id = await enter_ck(client, participant_headers, pages[0])
    answers = {
        "ck_0": {"lines": [0], "explanation": "", "skipped": True}
        if skip
        else {"lines": [3], "explanation": "Saved before deadline"}
    }
    body = {"visit_id": visit_id, "client_ts": 1_001_000, "answers": answers, "advance": True}
    endpoint = f"/participant/questionnaires/{pages[0].id}/respond"
    response = await client.post(endpoint, headers=participant_headers, json=body)
    assert response.status_code == 201, response.text
    attempt = await db.scalar(select(SectionAttempt))
    attempt.deadline_ms = 1
    await db.flush()
    retry = await client.post(endpoint, headers=participant_headers, json=body)
    assert retry.status_code == 201, retry.text
    assert session.current_step_index == 2
    saved = (await db.scalars(select(QuestionnaireResponse))).all()
    assert len(saved) == 1
    assert saved[0].answers == answers


@pytest.mark.parametrize("legacy", [False, True])
async def test_expired_deadline_does_not_block_legacy_or_finished_attempt_review(
    client, db, timed_pilot, pilot_study, participant_headers, legacy
):
    pages, session = timed_pilot
    visit_id = await enter_ck(client, participant_headers, pages[0])
    attempt = await db.scalar(select(SectionAttempt))
    attempt.deadline_ms = 1
    if legacy:
        pilot_study.flow_version = "legacy"
    else:
        attempt.ended_client_ts = 1_420_000
        attempt.exit_reason = "timer_expired"
    await db.flush()
    response = await client.post(
        f"/participant/questionnaires/{pages[0].id}/respond",
        headers=participant_headers,
        json={
            "visit_id": visit_id,
            "client_ts": 1_430_000,
            "answers": {"ck_0": {"lines": [3], "explanation": "Review"}},
            "advance": True,
        },
    )
    assert response.status_code == 201, response.text
    assert session.current_step_index == 2
