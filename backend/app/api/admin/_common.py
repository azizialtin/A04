"""Pieces every admin module needs: lookups that 404, enum parsing, the audit
hook, and the response shapes."""

from __future__ import annotations

from fastapi import BackgroundTasks, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import ActorType, PhaseType, QuestionnairePlacement
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire
from app.models.researcher import Researcher
from app.models.study import Study
from app.models.video import Video
from app.schemas.admin import (
    QuestionnaireOut,
    StudyResponse,
    StudyTexts,
    StudyVideoDefaults,
    VideoResponse,
)
from app.services.audit import record_audit

MAX_PARTICIPANT_ID_LENGTH = 64  # matches Participant.id


def _phase(value: str) -> PhaseType:
    try:
        return PhaseType(value)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid phase_type: {value!r}") from None


def _placement(value: str) -> QuestionnairePlacement:
    try:
        return QuestionnairePlacement(value)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid placement: {value!r}") from None


async def _study_or_404(db: AsyncSession, study_id: int) -> Study:
    study = await db.get(Study, study_id)
    if study is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Study not found.")
    return study


async def _participant_or_404(db: AsyncSession, participant_id: str) -> Participant:
    p = await db.scalar(select(Participant).where(Participant.id == participant_id))
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Participant not found.")
    return p


async def _participant_for_update(db: AsyncSession, participant_id: str) -> Participant:
    """The participant with their row locked until the request commits.

    Anything that checks "have they started yet?" and then rewrites their run
    has to hold the row across both, or the check and the write can straddle
    the participant's own first login — and the case order would change under
    someone already sitting in front of it.
    """
    p = await db.scalar(
        select(Participant).where(Participant.id == participant_id).with_for_update()
    )
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Participant not found.")
    return p


def _audit(
    background_tasks: BackgroundTasks, admin: Researcher, action: str, meta: dict | None = None
) -> None:
    background_tasks.add_task(
        record_audit,
        actor_email=admin.email,
        actor_type=ActorType.admin,
        action=action,
        ip_address=None,
        meta=meta or {},
    )


def _study_out(s: Study) -> StudyResponse:
    return StudyResponse(
        id=s.id,
        name=s.name,
        description=s.description,
        sosci_pretest_url=s.sosci_pretest_url,
        sosci_posttest_url=s.sosci_posttest_url,
        sosci_id_param=s.sosci_id_param,
        is_active=s.is_active,
        texts=StudyTexts.model_validate(s.texts or {}),
        video_defaults=StudyVideoDefaults.model_validate(s.video_defaults or {}),
        think_aloud_batch_size=s.think_aloud_batch_size,
    )


def _video_out(v: Video) -> VideoResponse:
    return VideoResponse(
        id=v.id,
        study_id=v.study_id,
        title=v.title,
        phase_type=v.phase_type.value,
        task_description=v.task_description,
        info_text=v.info_text,
        student_task_text=v.student_task_text,
        time_limit_seconds=v.time_limit_seconds,
        has_file=bool(v.gcp_filename),
        use_default_task=v.use_default_task,
        use_default_info=v.use_default_info,
    )


def _q_out(q: Questionnaire) -> QuestionnaireOut:
    return QuestionnaireOut(
        id=q.id,
        study_id=q.study_id,
        placement=q.placement.value,
        title=q.title,
        description=q.description,
        section=q.section,
        order_index=q.order_index,
        questions=q.questions,
    )
