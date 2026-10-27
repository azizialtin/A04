"""The question batteries: the pre-test pages, the diagnosis ratings, and the
short set asked after each case."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.enums import SINGLE_PER_STUDY, QuestionnairePlacement
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.researcher import Researcher
from app.models.session import Session
from app.models.study import Study
from app.schemas.admin import QuestionnaireCreate, QuestionnaireOut, QuestionnaireUpdate
from app.services.study_content import seed_batteries

from ._common import _audit, _placement, _q_out, _study_or_404

router = APIRouter()

_SINGLE_LABELS = ", ".join(p.value for p in SINGLE_PER_STUDY)


async def _lock_study(db: AsyncSession, study_id: int) -> None:
    await db.execute(select(Study.id).where(Study.id == study_id).with_for_update())


async def _require_unstarted(db: AsyncSession, study_id: int) -> None:
    started = await db.scalar(
        select(Session.id)
        .join(Participant, Participant.id == Session.participant_id)
        .where(Participant.study_id == study_id)
        .limit(1)
    )
    if started is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This study has started runs. Change the instrument in a new study; wording corrections remain available.",
        )


def _structure(questions: list[dict]) -> list[dict]:
    return [
        {key: value for key, value in question.items() if key != "text"} for question in questions
    ]


async def _validate_sections(db: AsyncSession, study_id: int) -> None:
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            409, "This study already has a questionnaire for that placement."
        ) from None
    rows = (
        await db.scalars(
            select(Questionnaire)
            .where(Questionnaire.study_id == study_id)
            .order_by(Questionnaire.order_index, Questionnaire.id)
        )
    ).all()
    seen: set[str] = set()
    previous = ""
    for q in rows:
        if (
            q.section_key or q.intro_title or q.intro_body
        ) and q.placement != QuestionnairePlacement.pre_test:
            raise HTTPException(422, "Section introductions are only available for pre-test pages.")
        if (q.intro_title or q.intro_body) and not q.section_key:
            raise HTTPException(422, "A section introduction needs a section key.")
        if not q.questions or q.placement != QuestionnairePlacement.pre_test:
            continue
        key = q.section_key
        if key and key in seen and (q.intro_title or q.intro_body):
            raise HTTPException(422, "Put the section introduction on its first populated page.")
        if key and key != previous and key in seen:
            raise HTTPException(422, "Pages of one section must be consecutive.")
        if key:
            seen.add(key)
        previous = key


async def _commit_unique(db: AsyncSession) -> None:
    """Commit, turning the one-per-study rule into an answer the admin can act on."""
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This study already has a questionnaire for that placement ({_SINGLE_LABELS} "
            "allow only one each).",
        ) from None


@router.get("/studies/{study_id}/questionnaires", response_model=list[QuestionnaireOut])
async def list_questionnaires(
    study_id: int,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[QuestionnaireOut]:
    await _study_or_404(db, study_id)
    rows = (
        (
            await db.execute(
                select(Questionnaire)
                .where(Questionnaire.study_id == study_id)
                .order_by(Questionnaire.order_index, Questionnaire.id)
            )
        )
        .scalars()
        .all()
    )
    return [_q_out(q) for q in rows]


@router.post(
    "/studies/{study_id}/questionnaires",
    response_model=QuestionnaireOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_questionnaire(
    study_id: int,
    body: QuestionnaireCreate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> QuestionnaireOut:
    await _study_or_404(db, study_id)
    await _lock_study(db, study_id)
    await _require_unstarted(db, study_id)
    q = Questionnaire(
        study_id=study_id,
        placement=_placement(body.placement),
        title=body.title,
        description=body.description,
        section=body.section.strip(),
        section_key=body.section_key,
        intro_title=body.intro_title,
        intro_body=body.intro_body,
        order_index=body.order_index,
        questions=body.questions,
    )
    db.add(q)
    await _validate_sections(db, study_id)
    await _commit_unique(db)
    await db.refresh(q)
    _audit(background_tasks, admin, "questionnaire_created", {"questionnaire_id": q.id})
    return _q_out(q)


@router.post(
    "/studies/{study_id}/questionnaires/seed",
    response_model=list[QuestionnaireOut],
    status_code=status.HTTP_201_CREATED,
)
async def seed_questionnaires(
    study_id: int,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[QuestionnaireOut]:
    """Add the standard A04 batteries this study is missing.

    New studies get them on creation; this is for the ones made before, and for
    putting a battery back after it was deleted.
    """
    await _study_or_404(db, study_id)
    await _lock_study(db, study_id)
    await _require_unstarted(db, study_id)
    created = await seed_batteries(db, study_id)
    await _commit_unique(db)
    for q in created:
        await db.refresh(q)
    _audit(background_tasks, admin, "questionnaires_seeded", {"study_id": study_id})
    return [_q_out(q) for q in created]


@router.patch("/questionnaires/{questionnaire_id}", response_model=QuestionnaireOut)
async def update_questionnaire(
    questionnaire_id: int,
    body: QuestionnaireUpdate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> QuestionnaireOut:
    q = await db.get(Questionnaire, questionnaire_id)
    if q is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Questionnaire not found.")
    await _lock_study(db, q.study_id)
    await db.refresh(q)
    data = body.model_dump(exclude_unset=True)
    for field in ("section", "section_key", "intro_title", "intro_body"):
        if field in data:
            data[field] = (data[field] or "").strip()
    structural = any(
        data.get(field) is not None and data[field] != getattr(q, field)
        for field in ("order_index", "section_key")
    )
    structural |= data.get("placement") is not None and data["placement"] != q.placement.value
    if data.get("questions") is not None:
        structural |= _structure(data["questions"]) != _structure(q.questions)
    structural |= bool(
        data.get("intro_title", q.intro_title) or data.get("intro_body", q.intro_body)
    ) != bool(q.intro_title or q.intro_body)
    if structural:
        await _require_unstarted(db, q.study_id)
    if data.get("placement") is not None:
        q.placement = _placement(data.pop("placement"))
    else:
        data.pop("placement", None)
    for field, value in data.items():
        if field in ("section", "section_key", "intro_title", "intro_body"):
            value = (value or "").strip()
        if value is None:
            continue
        setattr(q, field, value)
    await _validate_sections(db, q.study_id)
    await _commit_unique(db)
    await db.refresh(q)
    _audit(background_tasks, admin, "questionnaire_updated", {"questionnaire_id": q.id})
    return _q_out(q)


@router.delete("/questionnaires/{questionnaire_id}")
async def delete_questionnaire(
    questionnaire_id: int,
    background_tasks: BackgroundTasks,
    force: bool = Query(False),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    q = await db.get(Questionnaire, questionnaire_id)
    if q is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Questionnaire not found.")
    await _lock_study(db, q.study_id)
    await _require_unstarted(db, q.study_id)
    responses = await db.scalar(
        select(func.count())
        .select_from(QuestionnaireResponse)
        .where(QuestionnaireResponse.questionnaire_id == questionnaire_id)
    )
    if responses and not force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Questionnaire has {responses} response(s). Pass force=true to delete them too.",
        )
    if responses:
        await db.execute(
            delete(QuestionnaireResponse).where(
                QuestionnaireResponse.questionnaire_id == questionnaire_id
            )
        )
    await db.delete(q)
    await db.commit()
    _audit(background_tasks, admin, "questionnaire_deleted", {"questionnaire_id": questionnaire_id})
    return {"status": "ok"}
