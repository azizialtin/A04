from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.session import Session
from app.schemas.participant import SectionTimingResponse

CK_SECTION = "ck_tasks"
CK_SECONDS = 420


def now_ms() -> int:
    return int(datetime.now(UTC).timestamp() * 1000)


async def lock_session(db: AsyncSession, participant_id: str) -> Session:
    session = await db.scalar(
        select(Session)
        .where(Session.participant_id == participant_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if session is None:
        raise HTTPException(404, "No active run.")
    return session


async def ck_attempt(db: AsyncSession, participant_id: str) -> SectionAttempt | None:
    return await db.scalar(
        select(SectionAttempt).where(
            SectionAttempt.participant_id == participant_id,
            SectionAttempt.section_key == CK_SECTION,
        )
    )


def timing_response(attempt: SectionAttempt | None) -> SectionTimingResponse | None:
    if attempt is None:
        return None
    return SectionTimingResponse(
        section_key=attempt.section_key,
        deadline_ms=attempt.deadline_ms,
        server_now_ms=now_ms(),
        finished=attempt.ended_client_ts is not None,
        started_client_ts=attempt.started_client_ts,
        ended_client_ts=attempt.ended_client_ts,
    )


def end_attempt(attempt: SectionAttempt | None, client_ts: int, reason: str) -> None:
    # Review after the timed sitting cannot rewrite its original duration.
    if attempt is None or attempt.ended_client_ts is not None:
        return
    if client_ts < attempt.started_client_ts:
        raise HTTPException(422, "Section exit precedes its entry.")
    attempt.ended_client_ts = client_ts
    attempt.finished_server_ms = now_ms()
    attempt.exit_reason = reason


async def get_visit(
    db: AsyncSession,
    participant_id: str,
    visit_id: str,
    questionnaire_id: int | None = None,
) -> QuestionnaireVisit:
    visit = await db.get(QuestionnaireVisit, visit_id)
    if visit is None or visit.participant_id != participant_id:
        raise HTTPException(404, "Page visit not found.")
    if questionnaire_id is not None and visit.questionnaire_id != questionnaire_id:
        raise HTTPException(409, "Page visit belongs to another questionnaire.")
    return visit


def close_visit(visit: QuestionnaireVisit, client_ts: int, reason: str) -> int:
    if client_ts < visit.entered_client_ts:
        raise HTTPException(422, "Page exit precedes its entry.")
    if visit.exited_client_ts is None:
        visit.exited_client_ts = client_ts
        visit.exit_reason = reason
    return (visit.exited_client_ts - visit.entered_client_ts) // 1000
