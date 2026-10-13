"""The question batteries: the pre-test pages, the diagnosis ratings, and the
short set asked after each case."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.enums import SINGLE_PER_STUDY
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.researcher import Researcher
from app.schemas.admin import QuestionnaireCreate, QuestionnaireOut, QuestionnaireUpdate
from app.services.study_content import seed_batteries

from ._common import _audit, _placement, _q_out, _study_or_404

router = APIRouter()

_SINGLE_LABELS = ", ".join(p.value for p in SINGLE_PER_STUDY)


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
    q = Questionnaire(
        study_id=study_id,
        placement=_placement(body.placement),
        title=body.title,
        description=body.description,
        section=body.section.strip(),
        order_index=body.order_index,
        questions=body.questions,
    )
    db.add(q)
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
    data = body.model_dump(exclude_unset=True)
    if data.get("placement") is not None:
        q.placement = _placement(data.pop("placement"))
    else:
        data.pop("placement", None)
    for field, value in data.items():
        if field == "section":
            value = (value or "").strip()
        setattr(q, field, value)
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
