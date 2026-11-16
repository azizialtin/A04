from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.questionnaire_timing import QuestionnaireVisit
from app.models.session import Session
from app.models.video import Video
from app.services.session_script import build_steps


@pytest_asyncio.fixture
async def required_run(db, seed_study, seed_participant):
    pages = [
        Questionnaire(
            study_id=seed_study.id,
            placement=placement,
            title=key or "Legacy questionnaire",
            section_key=key,
            order_index=index,
            questions=[{"id": "answer", "type": "free_text", "text": "Why?", "required": True}],
        )
        for index, (placement, key) in enumerate(
            [
                (QuestionnairePlacement.pre_test, key)
                for key in ("", "demographics", "ck_self", "pck", "mesp")
            ]
            + [(QuestionnairePlacement.diagnosis, ""), (QuestionnairePlacement.case_outro, "")]
        )
    ]
    video = Video(study_id=seed_study.id, title="Clip", phase_type=PhaseType.training)
    session = Session(participant_id=seed_participant.id)
    seed_participant.status = ParticipantStatus.active
    db.add_all([*pages, video, session])
    await db.flush()
    return pages, video, session


async def progress(client, headers, index, target=None):
    return await client.patch(
        "/participant/session/progress",
        headers=headers,
        json={
            "expected_step_index": index,
            "current_step_index": index + 1 if target is None else target,
        },
    )


@pytest.mark.parametrize("flow", ["legacy", "pilot_20261116"])
@pytest.mark.parametrize(
    "key", ["", "demographics", "ck_self", "pck", "mesp", "diagnosis", "case_outro"]
)
async def test_every_required_page_blocks_forward_progress_until_saved(
    client, db, seed_study, seed_participant, participant_headers, required_run, flow, key
):
    seed_study.flow_version = flow
    await db.flush()
    pages, video, session = required_run
    page = next(
        p
        for p in pages
        if (
            p.placement.value == key
            if key in {"diagnosis", "case_outro"}
            else p.placement == QuestionnairePlacement.pre_test and p.section_key == key
        )
    )
    steps = await build_steps(db, seed_participant)
    index = next(
        i
        for i, s in enumerate(steps)
        if (s["kind"] == key if key == "diagnosis" else s.get("questionnaire_id") == page.id)
    )
    session.current_step_index = index
    await db.flush()
    rejected = await progress(client, participant_headers, index)
    assert rejected.status_code == 409
    assert session.current_step_index == index and session.completed_at is None
    body = {"answers": {"answer": "Saved"}}
    visit_id = None
    if page.section_key:
        visit_id = str(uuid4())
        entered = await client.post(
            "/participant/session/questionnaire-visit",
            headers=participant_headers,
            json={
                "questionnaire_id": page.id,
                "step_index": index,
                "visit_id": visit_id,
                "client_ts": 1000,
            },
        )
        assert entered.status_code == 200
        body.update(visit_id=visit_id, client_ts=2000)
    if page.placement != QuestionnairePlacement.pre_test:
        body["video_id"] = video.id
    if key == "diagnosis":
        body["text"] = "Wrong loop bound"
    saved = await client.post(
        "/participant/diagnosis"
        if key == "diagnosis"
        else f"/participant/questionnaires/{page.id}/respond",
        headers=participant_headers,
        json=body,
    )
    assert saved.status_code == 201, saved.text
    accepted = await progress(client, participant_headers, index)
    assert accepted.status_code == 200, accepted.text
    assert session.current_step_index == index + 1
    assert session.current_questionnaire_visit_id is None
    if visit_id:
        assert (await db.get(QuestionnaireVisit, visit_id)).exit_reason == "submitted"
    retried = await progress(client, participant_headers, index)
    assert retried.status_code == 200
    assert session.current_step_index == index + 1


async def test_saved_answer_cannot_authorize_skipping_later_pages(
    client, db, seed_participant, participant_headers, required_run
):
    pages, _, session = required_run
    first = pages[0]
    db.add(
        QuestionnaireResponse(
            questionnaire_id=first.id,
            participant_id=seed_participant.id,
            answers={"answer": "Saved"},
        )
    )
    await db.flush()
    steps = await build_steps(db, seed_participant)
    index = next(i for i, s in enumerate(steps) if s.get("questionnaire_id") == first.id)
    for origin in (0, index):
        session.current_step_index = origin
        await db.flush()
        result = await progress(client, participant_headers, origin, len(steps))
        assert result.status_code == 409
        assert session.current_step_index == origin and session.completed_at is None


async def test_reentered_timed_page_needs_current_visit_save_even_when_previous_answer_exists(
    client, db, seed_participant, participant_headers, required_run
):
    pages, _, session = required_run
    page = pages[3]
    steps = await build_steps(db, seed_participant)
    index = next(i for i, s in enumerate(steps) if s.get("questionnaire_id") == page.id)
    session.current_step_index = index
    await db.flush()
    for ts in (2000, 1000):
        visit_id = str(uuid4())
        entered = await client.post(
            "/participant/session/questionnaire-visit",
            headers=participant_headers,
            json={
                "questionnaire_id": page.id,
                "step_index": index,
                "visit_id": visit_id,
                "client_ts": ts,
            },
        )
        assert entered.status_code == 200
        assert (await progress(client, participant_headers, index)).status_code == 409
        submitted = await client.post(
            f"/participant/questionnaires/{page.id}/respond",
            headers=participant_headers,
            json={
                "answers": {"answer": "Saved"},
                "visit_id": visit_id,
                "client_ts": ts + 500,
                "advance": True,
            },
        )
        assert submitted.status_code == 201
        back = await client.post("/participant/session/step-back", headers=participant_headers)
        assert back.status_code == 200 and session.current_step_index == index


async def test_supervisor_review_preserves_saved_diagnosis_and_outro(
    client, db, seed_participant, participant_headers, required_run
):
    pages, video, session = required_run
    steps = await build_steps(db, seed_participant)
    diagnosis_index = next(i for i, s in enumerate(steps) if s["kind"] == "diagnosis")
    session.current_step_index = diagnosis_index
    await db.flush()
    assert (
        await client.post(
            "/participant/diagnosis",
            headers=participant_headers,
            json={"video_id": video.id, "text": "Answer", "answers": {"answer": "Saved"}},
        )
    ).status_code == 201
    assert (await progress(client, participant_headers, diagnosis_index)).status_code == 200
    assert (
        await client.post(
            f"/participant/questionnaires/{pages[-1].id}/respond",
            headers=participant_headers,
            json={"video_id": video.id, "answers": {"answer": "Saved"}},
        )
    ).status_code == 201
    assert (await progress(client, participant_headers, diagnosis_index + 1)).status_code == 200
    for _ in range(2):
        assert (
            await client.post("/participant/session/step-back", headers=participant_headers)
        ).status_code == 200
    assert session.current_step_index == diagnosis_index
    for index in (diagnosis_index, diagnosis_index + 1):
        assert (await progress(client, participant_headers, index)).status_code == 200


async def test_invalid_historical_answers_do_not_satisfy_required_progress(
    client, db, seed_participant, participant_headers, required_run
):
    pages, _, session = required_run
    db.add(
        QuestionnaireResponse(
            questionnaire_id=pages[0].id, participant_id=seed_participant.id, answers={"answer": ""}
        )
    )
    await db.flush()
    steps = await build_steps(db, seed_participant)
    session.current_step_index = next(
        i for i, s in enumerate(steps) if s.get("questionnaire_id") == pages[0].id
    )
    await db.flush()
    response = await progress(client, participant_headers, session.current_step_index)
    assert response.status_code == 409
    assert len(list((await db.scalars(select(QuestionnaireResponse))).all())) == 1
