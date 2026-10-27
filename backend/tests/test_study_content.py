"""The batteries a study is born with, and that they say what the spreadsheet says."""

import pytest
from sqlalchemy import select

from app.models.enums import QuestionnairePlacement
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.models.study import Study
from app.services.log_data import MAIN_SCREEN_VARIABLES, variable_name
from app.services.questionnaires import validate_question_definitions, visible_question_ids
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
    assert validate_question_definitions(battery.questions) == []


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
        # Demographics, two CK self-assessments, thirteen tasks, PCK, seven MSK.
        *((QuestionnairePlacement.pre_test, i) for i in range(24)),
    ]


async def test_new_study_has_the_complete_october_instrument_once(client, db, admin_headers):
    from app.services.pretest_content import load_pretest_manifest, mapped_ck_tasks
    from app.services.study_content_import import import_ck_pretest

    created = await client.post(
        "/admin/studies", json={"name": "Oktober-Instrument"}, headers=admin_headers
    )
    study_id = created.json()["id"]
    pages = await _pre_test_pages(db, study_id)
    assert [page.section_key for page in pages] == [
        "demographics",
        "ck_self",
        "ck_self",
        *(["ck_tasks"] * 13),
        "pck",
        *(["msk"] * 7),
    ]
    assert [page.questions[0] for page in pages[3:16]] == mapped_ck_tasks()
    manifest = load_pretest_manifest()
    assert pages[3].intro_body == manifest["ck_intro"]["body"]
    assert all(not page.intro_body for page in pages[4:16])
    assert pages[16].questions == manifest["pck_example"]["questions"]
    assert pages[16].description == manifest["pck_example"]["description"]
    assert pages[16].intro_body
    # The same import command recognises a new study's existing source pages.
    messages = await import_ck_pretest(db, study_id, None, pages[16].id, apply=True)
    assert "No changes" in messages[0]
    assert len(await _pre_test_pages(db, study_id)) == 24


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
            Questionnaire.title == "Fachwissen Programmierung",
        )
    )
    ck.order_index = 5
    await db.flush()
    expected = await _placements(db, study_id)

    again = await client.post(
        f"/admin/studies/{study_id}/questionnaires/seed", headers=admin_headers
    )
    assert again.json() == []
    assert await _placements(db, study_id) == expected
    assert expected.count((QuestionnairePlacement.pre_test, 5)) == 2


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
    assert [q["placement"] for q in seeded.json()] == ["pre_test"] * 24 + ["diagnosis"]
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


def _migration(filename: str):
    """A migration module, loaded by file: the versions directory is not a package."""
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_section_migration_agrees_with_the_seeded_content():
    # The migration carries a frozen copy of the titles so it keeps working
    # after the content moves on; this says the copy and the content agree now.
    from app.services.study_content import DEFAULT_BATTERIES

    migration = _migration("a7c2e9d4f1b8_questionnaire_sections.py")

    seeded = {b.title: b.section for b in DEFAULT_BATTERIES}
    # Every page the migration knows is seeded with the section it assigns.
    # Pages added later, the MSK ones, arrive with their section already set.
    assert {t: seeded[t] for t in migration.SECTION_BY_TITLE} == migration.SECTION_BY_TITLE


def test_the_msk_pages_are_one_table_each_with_the_instrument_s_variable_names():
    from app.services.study_content import DEFAULT_BATTERIES, MSK_SCALE, MSK_TASKS

    pages = [b for b in DEFAULT_BATTERIES if b.section == "MSK"]
    assert [b.title for b in pages] == [f"MSK: Aufgabe {n}" for n in range(1, 8)]
    assert [len(b.questions) for b in pages] == [len(options) for _, options in MSK_TASKS]
    for number, page in enumerate(pages, start=1):
        # One table per page: every row shares the key and the scale.
        assert {q["matrix"] for q in page.questions} == {f"msk_pre_{number}"}
        assert {tuple(o["value"] for o in q["options"]) for q in page.questions} == {
            tuple(v for v, _ in MSK_SCALE)
        }
        assert [q["id"] for q in page.questions] == [
            f"msk_pre_{number}{letter}" for letter in "abcdef"[: len(page.questions)]
        ]
    # The general instruction opens the first page only, its guidance and its
    # scale as the bullet lists the instrument prints.
    assert pages[0].description.startswith("Die folgenden Aufgaben")
    blocks = pages[0].description.split("\n\n")
    assert blocks[2].count("\n- ") == 2 and blocks[2].startswith("- ")
    assert blocks[4].splitlines() == [f"- {v} = {label}" for v, label in MSK_SCALE]
    assert all(b.description.startswith("Stellen Sie sich vor") for b in pages[1:])
    assert all(
        b.description.endswith("Wie beurteilen Sie die folgenden Vorgehensweisen?") for b in pages
    )


def test_the_msk_migration_carries_the_same_pages_as_the_seed():
    from app.services.study_content import DEFAULT_BATTERIES

    migration = _migration("b3d8f2a6c4e1_msk_pre_test_pages.py")
    seeded = [
        {"title": b.title, "description": b.description, "questions": b.questions}
        for b in DEFAULT_BATTERIES
        if b.section == "MSK"
    ]
    assert seeded == migration.PAGES


async def _pointers(db) -> dict[str, int]:
    # Columns, not objects: the migration writes behind the identity map's back.
    rows = await db.execute(select(Session.participant_id, Session.current_step_index))
    return dict(rows.all())


async def _pre_test_pages(db, study_id: int) -> list[Questionnaire]:
    return list(
        (
            await db.execute(
                select(Questionnaire)
                .where(
                    Questionnaire.study_id == study_id,
                    Questionnaire.placement == QuestionnairePlacement.pre_test,
                )
                .order_by(Questionnaire.order_index, Questionnaire.id)
            )
        )
        .scalars()
        .all()
    )


async def test_the_msk_migration_appends_the_pages_and_keeps_every_run_on_its_screen(
    db, seed_researcher
):
    from sqlalchemy import text

    migration = _migration("b3d8f2a6c4e1_msk_pre_test_pages.py")

    # A study from before the instrument: the standard block without the MSK
    # pages, plus a page of the researcher's own at the end of the pre-test.
    study = Study(name="Vor MSK", description="", created_by=seed_researcher.id)
    db.add(study)
    await db.flush()
    # Historical fixture: today's default also includes CK tasks and PCK.
    # This old migration must still be checked against its original four pages.
    for index, (title, questions) in enumerate(
        [
            ("Angaben zur Person", [{"id": "age", "type": "number", "text": "Alter"}]),
            ("Fachdidaktisches Wissen", []),
            ("Fachwissen Programmierung", CK_PRE_TEST),
            ("Fachwissen Debugging", CK_DEBUG_PRE_TEST),
        ]
    ):
        db.add(
            Questionnaire(
                study_id=study.id,
                placement=QuestionnairePlacement.pre_test,
                title=title,
                questions=questions,
                order_index=index,
            )
        )
    own = {"id": "own_1", "type": "text", "text": "Eigene Frage"}
    db.add(
        Questionnaire(
            study_id=study.id,
            placement=QuestionnairePlacement.pre_test,
            title="Eigene Seite",
            order_index=4,
            questions=[own],
        )
    )
    # A study whose pre-test is entirely the researcher's own is left alone.
    other = Study(name="Eigener Vortest", description="", created_by=seed_researcher.id)
    db.add(other)
    await db.flush()
    db.add(
        Questionnaire(
            study_id=other.id,
            placement=QuestionnairePlacement.pre_test,
            title="Eigene Seite",
            questions=[own],
        )
    )
    # The pre-test a participant sees is four pages (the PCK page is seeded
    # empty), so index 5 is the first screen after it. Runs at every stage:
    # not started, inside the pre-test, just past it, deep in the cases.
    before = {"P-0": 0, "P-2": 2, "P-5": 5, "P-30": 30}
    for pid, index in before.items():
        db.add(Participant(id=pid, study_id=study.id))
        db.add(Session(participant_id=pid, current_step_index=index))
    db.add(Participant(id="O-5", study_id=other.id))
    db.add(Session(participant_id="O-5", current_step_index=5))
    await db.flush()

    touched = await db.run_sync(lambda s: migration.add_pages(s.connection()))

    assert touched == [study.id]
    pages = await _pre_test_pages(db, study.id)
    assert [(p.title, p.order_index) for p in pages[4:]] == [
        ("Eigene Seite", 4),
        *((f"MSK: Aufgabe {n}", 4 + n) for n in range(1, 8)),
    ]
    assert [(p.section, p.questions) for p in pages[5:]] == [
        ("MSK", page["questions"]) for page in migration.PAGES
    ]
    assert await _pointers(db) == {"P-0": 0, "P-2": 2, "P-5": 12, "P-30": 37, "O-5": 5}
    assert [p.title for p in await _pre_test_pages(db, other.id)] == ["Eigene Seite"]

    # Running it again adds nothing.
    assert await db.run_sync(lambda s: migration.add_pages(s.connection())) == []
    assert len(await _pre_test_pages(db, study.id)) == 12

    # The way back: the pages go with their answers, a run that was on one of
    # them resumes right after the pre-test, every other run keeps its screen.
    db.add(QuestionnaireResponse(questionnaire_id=pages[6].id, participant_id="P-30", answers={}))
    await db.flush()
    await db.execute(
        text("UPDATE sessions SET current_step_index = 8 WHERE participant_id = 'P-0'")
    )
    await db.run_sync(lambda s: migration.remove_pages(s.connection()))

    assert [p.title for p in await _pre_test_pages(db, study.id)][-1] == "Eigene Seite"
    assert (
        await db.scalar(
            select(QuestionnaireResponse).where(QuestionnaireResponse.participant_id == "P-30")
        )
        is None
    )
    assert await _pointers(db) == {"P-0": 5, "P-2": 2, "P-5": 5, "P-30": 30, "O-5": 5}
