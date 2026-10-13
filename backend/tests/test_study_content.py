"""The batteries a study is born with, and that they say what the spreadsheet says."""

import pytest
from sqlalchemy import select

from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire
from app.services.log_data import MAIN_SCREEN_VARIABLES, variable_name
from app.services.questionnaires import visible_question_ids
from app.services.study_content import CK_DEBUG_PRE_TEST, CK_PRE_TEST, DEFAULT_BATTERIES

ALL_QUESTIONS = [q for battery in DEFAULT_BATTERIES for q in battery.questions]

# The variable names on sheet "Log Data Collection on Main Screen", transcribed
# exactly — `playhad` is the sheet's own typo, and correcting it here would
# break the join it exists for. Every one of them has to have a producer.
LOGGED_ON_MAIN_SCREEN = {
    "enter_main_screen",
    "exit_main_screen",
    "click_event_play",
    "click_event_pause",
    "set_video_playhad_to",
    "click_event_notes_field",
    "type_in_notes_field",
    "click_event_info_button",
    "click_event_close_info_pop_up",
    "click_event_student_task_button",
    "click_event_close_student_task_pop_up",
}


def test_every_main_screen_variable_has_an_event():
    assert set(MAIN_SCREEN_VARIABLES.values()) == LOGGED_ON_MAIN_SCREEN


def test_one_press_of_play_is_one_row():
    """The player fires `video_replayed` alongside `video_resumed` for a replay.
    Naming both of them would double-count every replay in the export."""
    assert variable_name("video_replayed") == ""
    assert variable_name("video_resumed") == "click_event_play"
    assert variable_name("video_started") == "click_event_play"


@pytest.mark.parametrize("battery", DEFAULT_BATTERIES, ids=lambda b: b.title)
def test_a_battery_is_well_formed(battery):
    ids = [q["id"] for q in battery.questions]
    assert len(ids) == len(set(ids)), "duplicate variable name"
    for q in battery.questions:
        assert q["type"] in {"likert", "multiple_choice", "free_text", "slider", "number"}
        assert q["text"].strip()


def test_conditional_questions_point_at_a_question_that_exists():
    ids = {q["id"] for q in ALL_QUESTIONS}
    for q in ALL_QUESTIONS:
        trigger = q.get("show_if", {}).get("question")
        assert trigger is None or trigger in ids, q["id"]


def test_a_conditional_question_is_hidden_until_its_trigger_says_so():
    demographics = DEFAULT_BATTERIES[0].questions
    assert "st_semester" not in visible_question_ids(demographics, {"st_enrollment": 0})
    assert "st_semester" in visible_question_ids(demographics, {"st_enrollment": 1})


def test_the_concept_ladder_is_one_table_and_debugging_its_own_page():
    # Same key and the same seven statements on every concept row, or the
    # renderer would break them into separate tables.
    assert {q["matrix"] for q in CK_PRE_TEST} == {"ck_concepts"}
    assert len({tuple(o["value"] for o in q["options"]) for q in CK_PRE_TEST}) == 1
    assert [q["id"] for q in CK_DEBUG_PRE_TEST] == ["ck_pre_debug"]
    assert CK_DEBUG_PRE_TEST[0]["matrix"] == "ck_debug"
    titles = [b.title for b in DEFAULT_BATTERIES if b.placement.value == "pre_test"]
    assert titles.index("Fachwissen Programmierung") + 1 == titles.index("Fachwissen Debugging")


def test_the_variable_names_are_the_ones_the_data_dictionary_uses():
    ids = {q["id"] for q in ALL_QUESTIONS}
    assert {"sex", "age", "participant_group", "st_schulform", "java_ex"} <= ids
    assert {"ck_pre_vars", "ck_pre_loop", "ck_pre_debug"} <= ids
    assert {"confidence", "td_demand", "td_effort", "auth1", "auth2"} <= ids


async def _placements(db, study_id):
    rows = (
        (
            await db.execute(
                select(Questionnaire)
                .where(Questionnaire.study_id == study_id)
                .order_by(Questionnaire.placement, Questionnaire.order_index)
            )
        )
        .scalars()
        .all()
    )
    return [(q.placement, q.order_index) for q in rows]


async def test_a_new_study_arrives_with_the_standard_batteries(client, db, admin_headers):
    created = await client.post(
        "/admin/studies", json={"name": "Frisch angelegt"}, headers=admin_headers
    )
    assert created.status_code == 201

    placements = await _placements(db, created.json()["id"])
    assert sorted(placements) == [
        (QuestionnairePlacement.case_outro, 0),
        (QuestionnairePlacement.diagnosis, 0),
        (QuestionnairePlacement.pre_test, 0),
        (QuestionnairePlacement.pre_test, 1),
        (QuestionnairePlacement.pre_test, 2),
        (QuestionnairePlacement.pre_test, 3),
    ]


async def test_seeding_again_adds_nothing_and_changes_nothing(client, db, admin_headers):
    study_id = (
        await client.post("/admin/studies", json={"name": "Zweimal"}, headers=admin_headers)
    ).json()["id"]

    outro = await db.scalar(
        select(Questionnaire).where(
            Questionnaire.study_id == study_id,
            Questionnaire.placement == QuestionnairePlacement.case_outro,
        )
    )
    outro.title = "Vom Team umbenannt"
    await db.flush()

    again = await client.post(
        f"/admin/studies/{study_id}/questionnaires/seed", headers=admin_headers
    )
    assert again.status_code == 201
    assert again.json() == []

    await db.refresh(outro)
    assert outro.title == "Vom Team umbenannt"


async def test_reordering_a_page_does_not_earn_a_second_copy(client, db, admin_headers):
    """A page the researcher moved is still that page. Keying the seed on its
    position would hand the participant the same nine items twice."""
    study_id = (
        await client.post("/admin/studies", json={"name": "Umsortiert"}, headers=admin_headers)
    ).json()["id"]
    ck = await db.scalar(
        select(Questionnaire).where(
            Questionnaire.study_id == study_id,
            Questionnaire.placement == QuestionnairePlacement.pre_test,
            Questionnaire.order_index == 2,
        )
    )
    ck.order_index = 5
    await db.flush()

    again = await client.post(
        f"/admin/studies/{study_id}/questionnaires/seed", headers=admin_headers
    )
    assert again.json() == []
    assert await _placements(db, study_id) == [
        (QuestionnairePlacement.case_outro, 0),
        (QuestionnairePlacement.diagnosis, 0),
        (QuestionnairePlacement.pre_test, 0),
        (QuestionnairePlacement.pre_test, 1),
        (QuestionnairePlacement.pre_test, 3),
        (QuestionnairePlacement.pre_test, 5),
    ]


async def test_an_older_study_can_be_brought_up_to_date(client, db, seed_study, admin_headers):
    """The endpoint's whole point: a study that predates this content. Its outro
    battery may sit at any order_index, and that must not stop the rest."""
    db.add(
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.case_outro,
            title="Von Hand angelegt",
            order_index=1,
            questions=[{"id": "difficulty", "type": "likert", "text": "Wie schwer?"}],
        )
    )
    await db.flush()

    seeded = await client.post(
        f"/admin/studies/{seed_study.id}/questionnaires/seed", headers=admin_headers
    )
    assert seeded.status_code == 201
    assert [q["placement"] for q in seeded.json()] == [
        "pre_test",
        "pre_test",
        "pre_test",
        "pre_test",
        "diagnosis",
    ]
    # And the researcher's own outro battery is untouched.
    kept = await db.scalar(
        select(Questionnaire).where(
            Questionnaire.study_id == seed_study.id,
            Questionnaire.placement == QuestionnairePlacement.case_outro,
        )
    )
    assert kept.title == "Von Hand angelegt"


async def test_seeding_puts_back_a_deleted_battery(client, db, admin_headers):
    study_id = (
        await client.post(
            "/admin/studies", json={"name": "Wiederherstellen"}, headers=admin_headers
        )
    ).json()["id"]
    diagnosis = await db.scalar(
        select(Questionnaire).where(
            Questionnaire.study_id == study_id,
            Questionnaire.placement == QuestionnairePlacement.diagnosis,
        )
    )
    assert (
        await client.delete(f"/admin/questionnaires/{diagnosis.id}", headers=admin_headers)
    ).status_code == 200

    restored = await client.post(
        f"/admin/studies/{study_id}/questionnaires/seed", headers=admin_headers
    )
    assert [q["placement"] for q in restored.json()] == ["diagnosis"]
    assert [q["id"] for q in restored.json()[0]["questions"]] == ["confidence"]


async def test_a_second_outro_battery_is_refused(client, admin_headers):
    study_id = (
        await client.post("/admin/studies", json={"name": "Nur einmal"}, headers=admin_headers)
    ).json()["id"]

    r = await client.post(
        f"/admin/studies/{study_id}/questionnaires",
        json={"placement": "case_outro", "title": "Noch einer", "questions": []},
        headers=admin_headers,
    )
    assert r.status_code == 409


async def test_questions_before_a_case_are_no_longer_a_placement(client, seed_study, admin_headers):
    r = await client.post(
        f"/admin/studies/{seed_study.id}/questionnaires",
        json={"placement": "case_intro", "title": "Vor dem Fall", "questions": []},
        headers=admin_headers,
    )
    assert r.status_code == 400


def test_the_seeded_pages_carry_the_sections_the_researchers_named():
    from app.services.study_content import DEFAULT_BATTERIES

    sections = {b.title: b.section for b in DEFAULT_BATTERIES}
    assert sections["Angaben zur Person"] == "Demographics"
    assert sections["Fachdidaktisches Wissen"] == "PCK-Pretest"
    assert sections["Fachwissen Programmierung"] == "CK-Pretest"
    assert sections["Fachwissen Debugging"] == "CK-Pretest"
    # The per-case batteries stand alone.
    assert sections["Sicherheit der Diagnose"] == ""
    assert sections["Nach dem Fall"] == ""


def test_the_section_migration_agrees_with_the_seeded_content():
    # The migration carries a frozen copy of the titles so it keeps working
    # after the content moves on; this says the copy and the content agree now.
    import importlib.util
    from pathlib import Path

    from app.models.enums import QuestionnairePlacement
    from app.services.study_content import DEFAULT_BATTERIES

    path = (
        Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "a7c2e9d4f1b8_questionnaire_sections.py"
    )
    spec = importlib.util.spec_from_file_location("section_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    seeded = {
        b.title: b.section
        for b in DEFAULT_BATTERIES
        if b.placement == QuestionnairePlacement.pre_test
    }
    assert seeded == migration.SECTION_BY_TITLE
