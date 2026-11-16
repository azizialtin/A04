"""Researcher-supplied introductions must not shift an already started run."""

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire
from app.models.session import Session
from app.services.session_script import build_steps, pre_test_step_count


@pytest_asyncio.fixture
async def draft_sections(db, seed_study):
    pages = [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"Draft page {index}",
            section=key,
            section_key=key,
            order_index=index,
            questions=[{"id": f"item_{index}", "type": "free_text", "text": "Test item"}],
        )
        for index, key in enumerate(("demographics", "ck_self", "ck_self", "pck", "pck", "msk"))
    ]
    db.add_all(pages)
    await db.flush()
    return pages


@pytest.mark.parametrize("key", ["demographics", "ck_self", "pck", "msk"])
async def test_unstarted_introduction_round_trip_changes_only_its_script_step(
    client, db, admin_headers, seed_participant, draft_sections, key
):
    page = next(page for page in draft_sections if page.section_key == key)
    original = await build_steps(db, seed_participant)
    original_questions = page.questions
    assert pre_test_step_count(draft_sections) == len(draft_sections)
    for title, body in (
        ("Supplied introduction", "First paragraph.\n\n**Second paragraph.**"),
        ("Revised introduction", "Corrected wording."),
    ):
        response = await client.patch(
            f"/admin/questionnaires/{page.id}",
            json={"intro_title": title, "intro_body": body},
            headers=admin_headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["intro_title"] == title
        assert response.json()["intro_body"] == body
        assert response.json()["questions"] == original_questions
        script = await build_steps(db, seed_participant)
        intro_index = next(i for i, step in enumerate(script) if step["kind"] == "section_intro")
        assert script[intro_index]["section_key"] == key
        assert script[intro_index]["title"] == title
        assert script[intro_index]["body"] == body
        assert script[intro_index + 1]["questionnaire_id"] == page.id
        assert script[:intro_index] + script[intro_index + 1 :] == original
        assert pre_test_step_count(draft_sections) == len(draft_sections) + 1

    response = await client.patch(
        f"/admin/questionnaires/{page.id}",
        json={"intro_title": None, "intro_body": None},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["intro_title"] == response.json()["intro_body"] == ""
    assert await build_steps(db, seed_participant) == original
    assert pre_test_step_count(draft_sections) == len(draft_sections)


@pytest.mark.parametrize(
    ("existing", "change"),
    [
        (False, {"intro_title": "New introduction"}),
        (False, {"intro_body": "New introduction"}),
        (True, {"intro_title": "", "intro_body": ""}),
        (True, {"intro_title": None, "intro_body": None}),
        (True, {"intro_title": "  ", "intro_body": "\n "}),
    ],
)
async def test_first_login_freezes_intro_step_presence(
    client, db, admin_headers, seed_participant, draft_sections, existing, change
):
    page = draft_sections[0]
    if existing:
        page.intro_title = "Existing title"
        page.intro_body = "Existing introduction"
        await db.flush()
    login = await client.post(
        "/auth/participant/login", json={"participant_id": seed_participant.id}
    )
    assert login.status_code == 200, login.text
    before = await build_steps(db, seed_participant)
    response = await client.patch(
        f"/admin/questionnaires/{page.id}", json=change, headers=admin_headers
    )
    assert response.status_code == 409, response.text
    assert "started runs" in response.json()["detail"]
    assert await build_steps(db, seed_participant) == before
    session = await db.scalar(select(Session).where(Session.participant_id == seed_participant.id))
    assert session.current_step_index == 0


async def test_started_introduction_wording_remains_editable_without_shifting_pages(
    client, db, admin_headers, seed_participant, draft_sections
):
    page = draft_sections[0]
    page.intro_title = "Existing title"
    page.intro_body = "Existing introduction"
    db.add(Session(participant_id=seed_participant.id, current_step_index=3))
    await db.flush()
    before = await build_steps(db, seed_participant)
    response = await client.patch(
        f"/admin/questionnaires/{page.id}",
        json={"intro_title": "", "intro_body": "Corrected introduction"},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    after = await build_steps(db, seed_participant)
    assert len(after) == len(before)
    assert after[1]["kind"] == "section_intro"
    assert after[1]["title"] == page.section
    assert after[1]["body"] == "Corrected introduction"
    assert after[:1] + after[2:] == before[:1] + before[2:]
    session = await db.scalar(select(Session).where(Session.participant_id == seed_participant.id))
    assert session.current_step_index == 3


async def test_intro_on_later_populated_section_page_is_rejected(
    client, admin_headers, draft_sections
):
    response = await client.patch(
        f"/admin/questionnaires/{draft_sections[2].id}",
        json={"intro_body": "This would otherwise be silently absent from the participant script."},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text
    assert "first populated page" in response.json()["detail"]
