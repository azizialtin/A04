"""Studies: the container everything else hangs off."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire
from app.models.researcher import Researcher
from app.models.study import Study
from app.models.video import Video
from app.schemas.admin import StudyCreate, StudyResponse, StudyUpdate
from app.services.storage import (
    delete_participant_gaze,
    delete_participant_screens,
    delete_video_file,
)
from app.services.study_content import seed_batteries

from ._common import _audit, _study_or_404, _study_out

router = APIRouter()


@router.get("/studies", response_model=list[StudyResponse])
async def list_studies(
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[StudyResponse]:
    rows = (await db.execute(select(Study).order_by(Study.id.desc()))).scalars().all()
    return [_study_out(s) for s in rows]


@router.post("/studies", response_model=StudyResponse, status_code=status.HTTP_201_CREATED)
async def create_study(
    body: StudyCreate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> StudyResponse:
    study = Study(
        name=body.name,
        description=body.description,
        sosci_pretest_url=body.sosci_pretest_url,
        sosci_posttest_url=body.sosci_posttest_url,
        sosci_id_param=body.sosci_id_param,
        created_by=admin.id,
    )
    db.add(study)
    await db.flush()
    # Every A04 study asks the same pre-test, diagnosis and outro questions, so
    # a new one arrives with them already in place — the same reason uploading
    # videos alone is enough to give a participant a run.
    await seed_batteries(db, study.id)
    await db.commit()
    await db.refresh(study)
    _audit(background_tasks, admin, "study_created", {"study_id": study.id})
    return _study_out(study)


@router.get("/studies/{study_id}", response_model=StudyResponse)
async def get_study(
    study_id: int,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> StudyResponse:
    return _study_out(await _study_or_404(db, study_id))


@router.patch("/studies/{study_id}", response_model=StudyResponse)
async def update_study(
    study_id: int,
    body: StudyUpdate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> StudyResponse:
    study = await _study_or_404(db, study_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(study, field, value)
    await db.commit()
    await db.refresh(study)
    _audit(background_tasks, admin, "study_updated", {"study_id": study.id})
    return _study_out(study)


@router.delete("/studies/{study_id}")
async def delete_study(
    study_id: int,
    background_tasks: BackgroundTasks,
    force: bool = Query(False),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    study = await _study_or_404(db, study_id)
    count = await db.scalar(
        select(func.count()).select_from(Participant).where(Participant.study_id == study_id)
    )
    if count and not force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Study has {count} participant(s). Pass force=true to delete everything.",
        )
    # Note what lives outside the database before the rows that point at it go.
    participants = (
        (await db.execute(select(Participant.id).where(Participant.study_id == study_id)))
        .scalars()
        .all()
    )
    filenames = (
        (
            await db.execute(
                select(Video.gcp_filename).where(
                    Video.study_id == study_id, Video.gcp_filename.is_not(None)
                )
            )
        )
        .scalars()
        .all()
    )

    # Deleting participants cascades their notes/entries/events/gaze/responses/
    # sessions/sequence; then questionnaires and videos have nothing pointing at
    # them and can go, followed by the study itself.
    await db.execute(delete(Participant).where(Participant.study_id == study_id))
    await db.execute(delete(Questionnaire).where(Questionnaire.study_id == study_id))
    await db.execute(delete(Video).where(Video.study_id == study_id))
    await db.delete(study)
    await db.commit()

    settings = get_settings()
    for participant_id in participants:
        await run_in_threadpool(delete_participant_gaze, participant_id, settings)
        await run_in_threadpool(delete_participant_screens, participant_id, settings)
    for filename in filenames:
        await run_in_threadpool(delete_video_file, filename, settings)

    _audit(background_tasks, admin, "study_deleted", {"study_id": study_id})
    return {"status": "ok"}
