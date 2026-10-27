"""Preview or import the approved October CK instrument into an unstarted study."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import QuestionnairePlacement
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.models.study import Study
from app.services.pretest_content import (
    SOURCE_KEY,
)
from app.services.pretest_content import (
    ContentImportError as ContentImportError,
)
from app.services.pretest_content import (
    load_pretest_manifest as load_pretest_manifest,
)
from app.services.pretest_content import (
    mapped_ck_tasks as mapped_ck_tasks,
)
from app.services.study_content import CK_DEBUG_PRE_TEST, CK_PRE_TEST


def _source_row(questionnaire: Questionnaire) -> int | None:
    for question in questionnaire.questions:
        reference = question.get("source_ref")
        if isinstance(reference, dict) and reference.get("instrument") == SOURCE_KEY:
            row = reference.get("row")
            return row if isinstance(row, int) and not isinstance(row, bool) else None
    return None


async def import_ck_pretest(
    db: AsyncSession,
    study_id: int,
    mapping: Any = None,
    pck_questionnaire_id: int | None = None,
    *,
    apply: bool = False,
) -> list[str]:
    """Preview by default; the caller commits an explicitly requested import."""
    if pck_questionnaire_id is None:
        raise ContentImportError("Select the first PCK pre-test questionnaire in this study.")
    questions = mapped_ck_tasks(mapping)
    manifest = load_pretest_manifest()
    study = await db.scalar(select(Study).where(Study.id == study_id).with_for_update())
    if study is None:
        raise ContentImportError(f"No study with id {study_id}.")
    started = await db.scalar(
        select(Session.id)
        .join(Participant, Participant.id == Session.participant_id)
        .where(Participant.study_id == study_id)
        .limit(1)
    )
    response = await db.scalar(
        select(QuestionnaireResponse.id)
        .join(Questionnaire, Questionnaire.id == QuestionnaireResponse.questionnaire_id)
        .where(Questionnaire.study_id == study_id)
        .limit(1)
    )
    if started is not None or response is not None:
        raise ContentImportError(
            "This study has started runs or responses. Import into a new study instead."
        )
    pages = list(
        (
            await db.scalars(
                select(Questionnaire)
                .where(
                    Questionnaire.study_id == study_id,
                    Questionnaire.placement == QuestionnairePlacement.pre_test,
                )
                .order_by(Questionnaire.order_index, Questionnaire.id)
            )
        ).all()
    )
    target = next((page for page in pages if page.id == pck_questionnaire_id), None)
    if target is None or target.section_key not in {"", "pck"}:
        raise ContentImportError("Select the first PCK pre-test questionnaire in this study.")
    if not target.questions:
        raise ContentImportError(
            "The selected PCK page is empty. Add the reviewed PCK content before importing CK."
        )
    target_index = pages.index(target)
    self_ids = {question["id"] for question in [*CK_PRE_TEST, *CK_DEBUG_PRE_TEST]}
    if any(
        question.get("id") in self_ids or str(question.get("id", "")).startswith("ck_pre_self_")
        for page in pages[target_index:]
        for question in page.questions
    ):
        raise ContentImportError(
            "PCK currently precedes CK self-assessment. Arrange the draft study's sections in the admin first."
        )
    source_pages = [(row, page) for page in pages if (row := _source_row(page)) is not None]
    existing = dict(source_pages)
    expected_rows = [task["source_row"] for task in manifest["ck_tasks"]]
    if existing:
        if set(existing) != set(expected_rows) or len(source_pages) != len(questions):
            raise ContentImportError(
                "Only part of this import is present. Review existing pages before importing again."
            )
        for index, (row, question) in enumerate(zip(expected_rows, questions, strict=True)):
            page = existing[row]
            intro = manifest["ck_intro"] if index == 0 else {"title": "", "body": ""}
            if (
                page.questions != [question]
                or page.title != f"CK: Aufgabe {index + 1}"
                or page.description != ""
                or page.section != "CK-Debugging"
                or page.section_key != "ck_tasks"
                or page.intro_title != intro["title"]
                or page.intro_body != intro["body"]
            ):
                raise ContentImportError(
                    f"Imported CSV row {row} has been edited or remapped; no changes were made."
                )
        actual_rows = [
            _source_row(page)
            for page in pages[max(0, target_index - len(questions)) : target_index]
        ]
        if actual_rows != expected_rows or target.section_key != "pck":
            raise ContentImportError(
                "Imported sections have been reordered or relabeled; no changes were made."
            )
        return ["All thirteen CK task pages already match this import. No changes."]

    mapped_ids = {question["id"] for question in questions}
    if any(
        page.section_key == "ck_tasks"
        or any(question.get("id") in mapped_ids for question in page.questions)
        for page in pages
    ):
        raise ContentImportError(
            "Existing CK pages or variable IDs conflict with this import; no changes were made."
        )
    if any(page.section_key == "pck" for page in pages[:target_index]):
        raise ContentImportError("The selected target is not the first PCK page.")
    pck_end = target_index + 1
    while pck_end < len(pages) and pages[pck_end].section_key == "pck":
        pck_end += 1
    if any(page.section_key == "pck" for page in pages[pck_end:]):
        raise ContentImportError("PCK pages must be consecutive before importing CK.")

    changes = [f"Insert thirteen CK pages before questionnaire {target.id}: {target.title}."]
    for index, (task, question) in enumerate(zip(manifest["ck_tasks"], questions, strict=True)):
        changes.append(
            f"  + CK: Aufgabe {index + 1}: CSV row {task['source_row']} → {question['id']}"
        )
    changes.append(
        f"Set questionnaire {target.id} section key to pck; retain existing page order and content."
    )
    changes.append(
        "PCK source content and CK self-assessment variable IDs are unchanged by this CK import."
    )
    if not apply:
        return ["Dry run — no changes.", *changes]

    insertion_order = target.order_index
    for page in pages[target_index:]:
        page.order_index += len(questions)
    target.section_key = "pck"
    for index, question in enumerate(questions):
        intro = manifest["ck_intro"] if index == 0 else {"title": "", "body": ""}
        db.add(
            Questionnaire(
                study_id=study_id,
                placement=QuestionnairePlacement.pre_test,
                title=f"CK: Aufgabe {index + 1}",
                description="",
                section="CK-Debugging",
                section_key="ck_tasks",
                intro_title=intro["title"],
                intro_body=intro["body"],
                order_index=insertion_order + index,
                questions=[question],
            )
        )
    await db.flush()
    return changes
