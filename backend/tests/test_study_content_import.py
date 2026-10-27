import pytest
from sqlalchemy import func, select

from app.cli import _parser
from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire
from app.models.session import Session
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


def test_manifest_preserves_source_provenance_with_approved_unique_ids():
    manifest = load_pretest_manifest()
    tasks = manifest["ck_tasks"]
    assert len(tasks) == 13
    assert len({task["source_variable"] for task in tasks}) == 11
    assert all(set(task) == {"source_row", "source_variable", "question"} for task in tasks)
    assert all(task["question"]["max_entries"] == 5 for task in tasks)
    assert {task["question"]["id"] for task in tasks} == {f"ck_pre_{i:02d}" for i in range(1, 14)}
    by_row = {task["source_row"]: task for task in tasks}
    assert by_row[15]["question"]["id"] == "ck_pre_12"
    assert by_row[16]["question"]["id"] == "ck_pre_13"
    assert by_row[25]["question"]["id"] == "ck_pre_08"
    assert by_row[26]["question"]["id"] == "ck_pre_10"
    assert by_row[25]["source_variable"] == "ck_pre_12"
    assert by_row[26]["source_variable"] == "ck_pre_13"
    assert manifest["ck_id_mapping"]["rows"] == {
        str(task["source_row"]): task["question"]["id"] for task in tasks
    }
    blank = next(task for task in tasks if task["source_variable"] == "ck_pre_07")
    assert blank["question"]["code_blocks"][0]["code"][0] == ""
    assert blank["question"]["code_blocks"][0]["code"][1] == "public class Rechner"
    pair = next(task for task in tasks if task["source_variable"] == "ck_pre_09")
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


def test_mapping_override_must_be_complete_unique_and_keeps_source_order():
    tasks = load_pretest_manifest()["ck_tasks"]
    with pytest.raises(ContentImportError, match="row keys"):
        mapped_ck_tasks({})
    with pytest.raises(ContentImportError, match="unique"):
        mapped_ck_tasks({str(task["source_row"]): task["source_variable"] for task in tasks})
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
    assert [question["id"] for question in tasks] == [
        "ck_pre_01",
        "ck_pre_12",
        "ck_pre_13",
        "ck_pre_07",
        "ck_pre_02",
        "ck_pre_03",
        "ck_pre_04",
        "ck_pre_05",
        "ck_pre_06",
        "ck_pre_09",
        "ck_pre_11",
        "ck_pre_08",
        "ck_pre_10",
    ]
    assert [question["source_ref"]["row"] for question in tasks] == list(range(14, 27))
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
