import pytest
from sqlalchemy import func, select

from app.cli import _parser
from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.services.pretest_content import LEGACY_SOURCE_KEY, SOURCE_KEY
from app.services.study_content import seed_batteries
from app.services.study_content_import import (
    ContentImportError,
    import_ck_pretest,
    load_pretest_manifest,
    mapped_ck_tasks,
)


def _mapping():
    return {
        str(task["source_row"]): f"fixture_ck_{index + 1}"
        for index, task in enumerate(load_pretest_manifest()["ck_tasks"])
    }


def test_manifest_preserves_source_provenance_with_corrected_csv_ids():
    manifest = load_pretest_manifest()
    tasks = manifest["ck_tasks"]
    assert len(tasks) == 13
    assert len({task["source_variable"] for task in tasks}) == 13
    assert all(set(task) == {"source_row", "source_variable", "question"} for task in tasks)
    assert all(task["question"]["max_entries"] == 5 for task in tasks)
    assert {task["question"]["id"] for task in tasks} == {f"ck_pre_{i:02d}" for i in range(1, 14)}
    by_row = {task["source_row"]: task for task in tasks}
    assert by_row[15]["question"]["id"] == "ck_pre_02"
    assert by_row[16]["question"]["id"] == "ck_pre_03"
    assert by_row[25]["question"]["id"] == "ck_pre_12"
    assert by_row[26]["question"]["id"] == "ck_pre_13"
    assert by_row[25]["source_variable"] == "ck_pre_12"
    assert by_row[26]["source_variable"] == "ck_pre_13"
    assert manifest["ck_id_mapping"]["rows"] == {
        str(task["source_row"]): task["question"]["id"] for task in tasks
    }
    blank = by_row[17]
    assert blank["question"]["code_blocks"][0]["code"][0] == ""
    assert blank["question"]["code_blocks"][0]["code"][1] == "public class Rechner"
    pair = by_row[23]
    assert [
        (block["filename"], block["start_line"], len(block["code"]))
        for block in pair["question"]["code_blocks"]
    ] == [
        ("Königsland.java", 1, 14),
        ("Drache.java", 15, 15),
    ]
    assert len(manifest["pck_example"]["issues"]) == 2
    assert [question["type"] for question in manifest["pck_example"]["questions"]] == [
        "free_text",
        "ranking",
        "free_text",
    ]


def test_corrected_manifest_changes_only_ck_ids_and_provenance():
    legacy = load_pretest_manifest(LEGACY_SOURCE_KEY)
    current = load_pretest_manifest()
    assert current["ck_intro"] == legacy["ck_intro"]
    assert current["pck_example"] == legacy["pck_example"]
    assert legacy["ck_id_mapping"]["rows"] == {
        str(row): f"ck_pre_{number:02d}"
        for row, number in zip(
            range(14, 27), [1, 12, 13, 7, 2, 3, 4, 5, 6, 9, 11, 8, 10], strict=True
        )
    }
    crosswalk = current["ck_id_mapping"]
    assert crosswalk["previous_instrument"] == LEGACY_SOURCE_KEY
    assert crosswalk["crosswalk"] == [
        {
            "source_row": old["source_row"],
            "previous_id": old["question"]["id"],
            "current_id": new["question"]["id"],
        }
        for old, new in zip(legacy["ck_tasks"], current["ck_tasks"], strict=True)
    ]
    for old, new in zip(legacy["ck_tasks"], current["ck_tasks"], strict=True):
        assert old["source_row"] == new["source_row"]
        assert {k: v for k, v in old["question"].items() if k != "id"} == {
            k: v for k, v in new["question"].items() if k != "id"
        }


def test_mapping_override_must_be_complete_unique_and_keeps_source_order():
    tasks = load_pretest_manifest()["ck_tasks"]
    with pytest.raises(ContentImportError, match="row keys"):
        mapped_ck_tasks({})
    with pytest.raises(ContentImportError, match="unique"):
        mapped_ck_tasks({str(task["source_row"]): "same_id" for task in tasks})
    mapped = mapped_ck_tasks(_mapping())
    assert [question["source_ref"]["row"] for question in mapped] == [
        task["source_row"] for task in tasks
    ]
    assert load_pretest_manifest()["ck_tasks"][0]["question"]["id"] == "ck_pre_01"


def test_import_cli_defaults_to_preview():
    args = _parser().parse_args(
        [
            "import-ck-pretest",
            "--study-id",
            "1",
            "--pck-questionnaire-id",
            "2",
        ]
    )
    assert args.apply is False
    assert args.mapping is None


async def _pages(db, study):
    ck = Questionnaire(
        study_id=study.id,
        placement=QuestionnairePlacement.pre_test,
        title="CK self",
        order_index=2,
        questions=[{"id": "ck_pre_vars", "type": "free_text", "text": "Self"}],
    )
    pck = Questionnaire(
        study_id=study.id,
        placement=QuestionnairePlacement.pre_test,
        title="Reviewed PCK",
        order_index=3,
        questions=[{"id": "pck_pre_01a", "type": "free_text", "text": "Reviewed wording"}],
    )
    msk = Questionnaire(
        study_id=study.id,
        placement=QuestionnairePlacement.pre_test,
        title="MSK",
        order_index=4,
        questions=[{"id": "msk_1", "type": "free_text", "text": "Original"}],
    )
    db.add_all([ck, pck, msk])
    await db.flush()
    return ck, pck, msk


@pytest.mark.asyncio
async def test_import_preview_then_apply_is_idempotent_and_preserves_existing_content(
    db, seed_study
):
    ck, pck, msk = await _pages(db, seed_study)
    messages = await import_ck_pretest(db, seed_study.id, _mapping(), pck.id)
    assert messages[0].startswith("Dry run")
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 3
    assert [ck.order_index, pck.order_index, msk.order_index] == [2, 3, 4]
    await import_ck_pretest(db, seed_study.id, _mapping(), pck.id, apply=True)
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 16
    assert pck.questions == [{"id": "pck_pre_01a", "type": "free_text", "text": "Reviewed wording"}]
    assert msk.questions[0]["text"] == "Original"
    assert pck.section_key == "pck"
    pages = list(
        (
            await db.scalars(
                select(Questionnaire).order_by(Questionnaire.order_index, Questionnaire.id)
            )
        ).all()
    )
    assert pages[0] is ck and pages[-2:] == [pck, msk]
    assert pages[1].intro_title == "Debugging-Aufgaben"
    assert all(page.section_key == "ck_tasks" for page in pages[1:14])
    assert all(page.intro_body == "" for page in pages[2:14])
    assert (
        "No changes"
        in (await import_ck_pretest(db, seed_study.id, _mapping(), pck.id, apply=True))[0]
    )
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 16


@pytest.mark.asyncio
async def test_import_refuses_to_overwrite_researcher_edits(db, seed_study):
    _, pck, _ = await _pages(db, seed_study)
    await import_ck_pretest(db, seed_study.id, _mapping(), pck.id, apply=True)
    imported = await db.scalar(
        select(Questionnaire)
        .where(Questionnaire.section_key == "ck_tasks")
        .order_by(Questionnaire.order_index)
    )
    imported.questions = [{**imported.questions[0], "text": "Researcher wording"}]
    await db.flush()
    with pytest.raises(ContentImportError, match="edited or remapped"):
        await import_ck_pretest(db, seed_study.id, _mapping(), pck.id, apply=True)
    assert imported.questions[0]["text"] == "Researcher wording"


@pytest.mark.asyncio
async def test_import_refuses_started_runs_even_at_the_first_step(db, seed_study, seed_participant):
    _, pck, _ = await _pages(db, seed_study)
    db.add(Session(participant_id=seed_participant.id, current_step_index=0))
    await db.flush()
    with pytest.raises(ContentImportError, match="started runs"):
        await import_ck_pretest(db, seed_study.id, _mapping(), pck.id, apply=True)
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 3


@pytest.mark.asyncio
async def test_import_does_not_silently_reorder_existing_self_assessment(db, seed_study):
    ck, pck, _ = await _pages(db, seed_study)
    pck.order_index = 1
    await db.flush()
    with pytest.raises(ContentImportError, match="precedes CK self-assessment"):
        await import_ck_pretest(db, seed_study.id, _mapping(), pck.id, apply=True)
    assert ck.order_index == 2 and pck.order_index == 1


def test_default_mapping_is_approved_and_keeps_source_order_and_ids():
    tasks = mapped_ck_tasks()
    assert [question["id"] for question in tasks] == [f"ck_pre_{i:02d}" for i in range(1, 14)]
    assert [question["source_ref"]["row"] for question in tasks] == list(range(14, 27))
    assert {question["source_ref"]["instrument"] for question in tasks} == {SOURCE_KEY}
    assert tasks[-2]["source_ref"]["variable"] == "ck_pre_12"
    assert tasks[-1]["source_ref"]["variable"] == "ck_pre_13"
    tasks[0]["id"] = "mutated"
    assert mapped_ck_tasks()[0]["id"] == "ck_pre_01"


def test_import_cli_accepts_explicit_mapping_override():
    args = _parser().parse_args(
        [
            "import-ck-pretest",
            "--study-id",
            "1",
            "--pck-questionnaire-id",
            "2",
            "--mapping",
            "mapping.json",
        ]
    )
    assert args.mapping == "mapping.json"


async def test_import_uses_approved_mapping_without_override(db, seed_study):
    _, pck, _ = await _pages(db, seed_study)
    await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck.id, apply=True)
    pages = (
        await db.scalars(
            select(Questionnaire)
            .where(Questionnaire.section_key == "ck_tasks")
            .order_by(Questionnaire.order_index)
        )
    ).all()
    assert [page.questions[0]["id"] for page in pages] == [
        question["id"] for question in mapped_ck_tasks()
    ]
    assert pages[-2].questions[0]["source_ref"]["variable"] == "ck_pre_12"
    assert (
        "No changes"
        in (await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck.id, apply=True))[0]
    )


async def _legacy_import(db, study):
    _, pck, msk = await _pages(db, study)
    manifest = load_pretest_manifest(LEGACY_SOURCE_KEY)
    pages = []
    for index, question in enumerate(mapped_ck_tasks(source_key=LEGACY_SOURCE_KEY)):
        intro = manifest["ck_intro"] if index == 0 else {"title": "", "body": ""}
        page = Questionnaire(
            study_id=study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"CK: Aufgabe {index + 1}",
            description="",
            section="CK-Debugging",
            section_key="ck_tasks",
            intro_title=intro["title"],
            intro_body=intro["body"],
            order_index=3 + index,
            questions=[question],
        )
        pages.append(page)
    db.add_all(pages)
    pck.section_key = "pck"
    pck.order_index += 13
    msk.order_index += 13
    await db.flush()
    return pages, pck


@pytest.mark.parametrize("apply", [False, True])
async def test_legacy_import_remains_a_noop_without_renaming_old_variables(db, seed_study, apply):
    pages, pck = await _legacy_import(db, seed_study)
    original = [(page.id, page.order_index, page.questions) for page in pages]
    messages = await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck.id, apply=apply)
    assert "No changes" in messages[0]
    assert LEGACY_SOURCE_KEY in messages[0]
    assert "new study" in messages[0]
    assert [(page.id, page.order_index, page.questions) for page in pages] == original
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 16


async def test_corrected_defaults_preserve_a_started_legacy_instrument_and_answers(
    db, seed_study, seed_participant
):
    pages, pck = await _legacy_import(db, seed_study)
    answers = {"ck_pre_12": {"lines": [6], "explanation": "Historical answer"}}
    response = QuestionnaireResponse(
        questionnaire_id=pages[1].id,
        participant_id=seed_participant.id,
        answers=answers,
    )
    session = Session(participant_id=seed_participant.id, current_step_index=6)
    db.add_all([response, session])
    await db.flush()
    original = [(page.id, page.order_index, page.questions) for page in pages]
    created = await seed_batteries(db, seed_study.id)
    assert all(page.placement != QuestionnairePlacement.pre_test for page in created)
    with pytest.raises(ContentImportError, match="started runs or responses"):
        await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck.id, apply=True)
    for page in pages:
        await db.refresh(page)
    await db.refresh(response)
    await db.refresh(session)
    assert [(page.id, page.order_index, page.questions) for page in pages] == original
    assert response.answers == answers
    assert response.questionnaire_id == pages[1].id
    assert session.current_step_index == 6


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ("mixed", "multiple source versions"),
        ("partial", "Only part of this import"),
        ("edited", "edited or remapped"),
        ("remapping", "edited or remapped"),
    ],
)
async def test_legacy_import_cannot_be_partly_replaced_or_remapped(db, seed_study, change, message):
    pages, pck = await _legacy_import(db, seed_study)
    mapping = None
    if change == "mixed":
        pages[1].questions = [mapped_ck_tasks()[1]]
    elif change == "partial":
        await db.delete(pages[1])
    elif change == "edited":
        pages[1].questions = [{**pages[1].questions[0], "text": "Researcher correction"}]
    else:
        mapping = load_pretest_manifest()["ck_id_mapping"]["rows"]
    await db.flush()
    before = [(page.id, page.order_index, page.questions) for page in pages]
    with pytest.raises(ContentImportError, match=message):
        await import_ck_pretest(db, seed_study.id, mapping, pck.id, apply=True)
    assert [(page.id, page.order_index, page.questions) for page in pages] == before
