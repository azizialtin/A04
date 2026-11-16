from copy import deepcopy

import pytest
from sqlalchemy import select

from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.services.pretest_content import (
    LEGACY_SOURCE_KEY,
    PILOT_SOURCE_KEY,
    SOURCE_KEY,
    load_pretest_manifest,
    mapped_ck_tasks,
)
from app.services.questionnaires import missing_required_answers, validate_question_definitions
from app.services.study_content import (
    CASE_OUTRO,
    DEFAULT_BATTERIES,
    PILOT_BATTERIES,
    PILOT_CASE_OUTRO,
    refresh_unstarted_case_outro,
    seed_batteries,
)
from app.services.study_content_import import import_ck_pretest


def test_pilot_ck_uses_the_approved_order_without_changing_historical_instruments():
    pilot = load_pretest_manifest(PILOT_SOURCE_KEY)
    previous = load_pretest_manifest(SOURCE_KEY)
    mapping = [1, 6, 4, 13, 2, 5, 7, 8, 9, 10, 11, 12, 3]
    assert [row["previous_variable"] for row in pilot["ck_version_crosswalk"]["rows"]] == [
        f"ck_pre_{number:02}" for number in mapping
    ]
    for number, old_number in enumerate(mapping, 1):
        question = pilot["ck_tasks"][number - 1]["question"]
        old = previous["ck_tasks"][old_number - 1]["question"]
        assert question["id"] == f"ck_pre_{number:02}"
        assert question["allow_skip"] is True
        if number not in {2, 3, 4}:
            assert question["text"] == old["text"]
            assert question["code_blocks"] == old["code_blocks"]
    ck2, ck3, ck4 = [task["question"] for task in pilot["ck_tasks"][1:4]]
    assert "weiteresBuchAusleihbar" in "\n".join(ck2["code_blocks"][0]["code"])
    assert ck3["code_blocks"][0]["code"][1] == "public class Rechner {"
    assert "for (int i = 1; i < werte.length; i++)" in "\n".join(ck3["code_blocks"][0]["code"])
    assert "for (int i = 0; i < stärken.length - 1; i++)" in "\n".join(
        ck4["code_blocks"][0]["code"]
    )
    assert (
        "ausgelieheneBücher < maximaleBücherzahl" in pilot["ck_tasks"][1]["solution"]["explanation"]
    )
    assert "noch nicht erreicht" in pilot["ck_tasks"][1]["solution"]["explanation"]
    assert all(
        "solution" not in question for question in mapped_ck_tasks(source_key=PILOT_SOURCE_KEY)
    )
    for source in (LEGACY_SOURCE_KEY, SOURCE_KEY):
        historical = load_pretest_manifest(source)
        assert all("allow_skip" not in task["question"] for task in historical["ck_tasks"])
        assert "pck_example" in historical
        assert "mesp_pages" not in historical
    assert len([battery for battery in DEFAULT_BATTERIES if battery.section_key == "msk"]) == 7


@pytest.mark.parametrize("battery", PILOT_BATTERIES, ids=lambda battery: battery.title)
def test_pilot_questions_are_valid_and_have_unique_variables(battery):
    assert validate_question_definitions(battery.questions) == []
    ids = [question["id"] for question in battery.questions]
    assert len(ids) == len(set(ids))


def test_pck_preserves_ten_conceptual_items_and_their_distinct_response_forms():
    pages = load_pretest_manifest(PILOT_SOURCE_KEY)["pck_pages"]
    assert [page["source_task"] for page in pages] == [1, 3, 5]
    concepts = {
        question["source_ref"]["variable"] for page in pages for question in page["questions"]
    }
    assert concepts == {
        "pck_pre_1a",
        "pck_pre_1b",
        "pck_pre_1c",
        "pck_pre_3a",
        "pck_pre_3b",
        "pck_pre_3c",
        "pck_pre_5a",
        "pck_pre_5b",
        "pck_pre_5c",
        "pck_pre_5d",
    }
    assert "```java" in pages[0]["description"]
    assert "LibraryAccount" in pages[1]["description"]
    code = pages[1]["description"].split("```java\n")[1].split("```")[0]
    assert code.count("{") == code.count("}")
    assert "currentlyBorrowed <= maxBooks" in code
    assert "```" not in pages[2]["description"]

    questions = {question["id"]: question for page in pages for question in page["questions"]}
    pick_two = questions["pck_pre_3b"]
    assert pick_two["min_selections"] == pick_two["max_selections"] == 2
    assert len(pick_two["options"]) == 4
    justification = questions["pck_pre_3b_justification"]
    pair = [pick_two, justification]
    assert missing_required_answers(pair, {"pck_pre_3b": [1, 3]}) == ["pck_pre_3b_justification"]
    assert (
        missing_required_answers(
            pair, {"pck_pre_3b": [1, 3], "pck_pre_3b_justification": "Begründung"}
        )
        == []
    )
    assert "pck_pre_3b" in missing_required_answers(
        pair, {"pck_pre_3b": [1], "pck_pre_3b_justification": "Begründung"}
    )
    assert "pck_pre_3b" in missing_required_answers(
        pair, {"pck_pre_3b": [1, 2, 3], "pck_pre_3b_justification": "Begründung"}
    )
    ranking = questions["pck_pre_5c"]
    assert ranking["type"] == "ranking"
    assert len(ranking["options"]) == 4
    assert ranking["options"][0]["label"].startswith("Den Schüler erläutern lassen")
    for variable in ("pck_pre_1b_1", "pck_pre_3a_1", "pck_pre_5b_1"):
        assert [option["label"] for option in questions[variable]["options"]] == [
            "sehr plausibel",
            "plausibel",
            "neutral",
            "eher nicht plausibel",
            "gar nicht plausibel",
        ]
        assert questions[variable]["matrix_prompt"]
    for variable in ("pck_pre_1c_1", "pck_pre_3c_1", "pck_pre_5d_1"):
        assert "(1 = sehr geeignet, 5 = gar nicht geeignet)" in questions[variable]["matrix_prompt"]
        assert [option["label"] for option in questions[variable]["options"]] == [
            "1",
            "2",
            "3",
            "4",
            "5",
        ]


def test_mesp_has_six_fixed_situations_with_independent_six_point_ratings():
    content = load_pretest_manifest(PILOT_SOURCE_KEY)
    pages = content["mesp_pages"]
    assert len(pages) == 6
    assert [len(page["questions"]) for page in pages] == [5] * 6
    assert "jede Zahl (1–6) nur einmal" in content["mesp_intro"]["body"]  # noqa: RUF001
    assert "nicht mit ihr kombiniert" in content["mesp_intro"]["body"]
    assert [question["source_ref"]["source_label"] for question in pages[1]["questions"]] == [
        "a",
        "b",
        "d",
        "e",
        "F",
    ]
    assert [question["id"] for question in pages[1]["questions"]] == [
        "mesp_pre_2a",
        "mesp_pre_2b",
        "mesp_pre_2c",
        "mesp_pre_2d",
        "mesp_pre_2e",
    ]
    assert "Ihre?" not in pages[4]["questions"][0]["text"]
    for number, page in enumerate(pages, 1):
        assert page["title"] == f"MESP: Aufgabe {number}"
        for question in page["questions"]:
            assert question["type"] == "multiple_choice"
            assert [option["value"] for option in question["options"]] == list(range(1, 7))
            assert question["options"][0]["label"].startswith("sehr geeignete")
            assert question["options"][-1]["label"].startswith("sehr ungeeignete")
        assert (
            missing_required_answers(page["questions"], {q["id"]: 2 for q in page["questions"]})
            == []
        )
    seeded = [battery for battery in PILOT_BATTERIES if battery.section_key == "mesp"]
    assert seeded[0].intro_body == content["mesp_intro"]["body"]
    assert all(not battery.intro_body for battery in seeded[1:])
    assert content["mesp_intro"]["body"] not in seeded[0].description


async def test_new_study_uses_pilot_manifest_and_import_is_idempotent(client, db, admin_headers):
    response = await client.post("/admin/studies", json={"name": "Pilot"}, headers=admin_headers)
    assert response.status_code == 201
    study_id = response.json()["id"]
    pages = list(
        await db.scalars(
            select(Questionnaire)
            .where(
                Questionnaire.study_id == study_id,
                Questionnaire.placement == QuestionnairePlacement.pre_test,
            )
            .order_by(Questionnaire.order_index)
        )
    )
    assert [page.section_key for page in pages] == [
        "demographics",
        "ck_self",
        "ck_self",
        *(["ck_tasks"] * 13),
        *(["pck"] * 3),
        *(["mesp"] * 6),
    ]
    assert [page.questions[0] for page in pages[3:16]] == mapped_ck_tasks(
        source_key=PILOT_SOURCE_KEY
    )
    before = [(page.id, page.questions) for page in pages]
    messages = await import_ck_pretest(db, study_id, pck_questionnaire_id=pages[16].id, apply=True)
    assert "No changes" in messages[0]
    assert [(page.id, page.questions) for page in pages] == before


async def test_pilot_ck_import_uses_the_pilot_source_for_an_empty_draft(db, seed_study):
    seed_study.flow_version = "pilot_20261116"
    pck = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="PCK",
        section_key="pck",
        order_index=3,
        questions=[{"id": "draft", "type": "free_text", "text": "Draft"}],
    )
    db.add(pck)
    await db.flush()
    await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck.id, apply=True)
    pages = list(
        await db.scalars(
            select(Questionnaire)
            .where(Questionnaire.study_id == seed_study.id, Questionnaire.section_key == "ck_tasks")
            .order_by(Questionnaire.order_index)
        )
    )
    assert [page.questions[0] for page in pages] == mapped_ck_tasks(source_key=PILOT_SOURCE_KEY)


async def test_outro_refresh_only_changes_stock_wording_in_an_unstarted_draft(db, seed_study):
    seed_study.flow_version = "pilot_20261116"
    questions = deepcopy(CASE_OUTRO)
    questions[-1]["text"] = "Eigene Formulierung"
    page = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Own title",
        questions=questions,
    )
    db.add(page)
    await db.flush()
    await seed_batteries(db, seed_study.id)
    assert page.title == "Own title"
    assert page.questions[:3] == PILOT_CASE_OUTRO[:3]
    assert page.questions[-1]["text"] == "Eigene Formulierung"


@pytest.mark.parametrize("history", ["session", "response"])
async def test_outro_refresh_never_changes_started_or_answered_content(
    db, seed_study, seed_participant, history
):
    page = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Historic",
        questions=deepcopy(CASE_OUTRO),
    )
    db.add(page)
    await db.flush()
    if history == "session":
        db.add(Session(participant_id=seed_participant.id))
    else:
        db.add(
            QuestionnaireResponse(
                questionnaire_id=page.id, participant_id=seed_participant.id, answers={"auth1": 2}
            )
        )
    await db.flush()
    assert await refresh_unstarted_case_outro(db, seed_study.id) == 0
    assert page.questions == CASE_OUTRO
