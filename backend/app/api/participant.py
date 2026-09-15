"""Participant-facing endpoints: the session script plus everything a run writes."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_participant
from app.models.enums import ParticipantStatus, QuestionnairePlacement
from app.models.note import Note
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.models.study import Study
from app.models.text_entry import TextEntry
from app.models.video import Video
from app.schemas.participant import (
    DiagnosisCreate,
    EventCreate,
    IdResponse,
    NoteCreate,
    NoteResponse,
    ParticipantMeResponse,
    ProgressResult,
    ProgressUpdateRequest,
    QuestionnaireRespondRequest,
    SessionScriptResponse,
    VideoUrlResponse,
)
from app.services.event_logger import log_event
from app.services.questionnaires import missing_required_answers
from app.services.session_script import build_steps, describe_step, video_in_run
from app.services.video_url import sign_blob_url

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(
    prefix="/participant",
    tags=["participant"],
    dependencies=[Depends(get_current_participant)],
)


async def _require_assigned(db: AsyncSession, participant: Participant, video_id: int) -> None:
    if not await video_in_run(db, participant, video_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That video isn't part of your run.")


@router.get("/me", response_model=ParticipantMeResponse)
async def get_me(
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> ParticipantMeResponse:
    study = await db.get(Study, participant.study_id)
    return ParticipantMeResponse(
        id=participant.id,
        study_name=study.name if study else "",
        status=participant.status.value,
    )


@router.get("/session", response_model=SessionScriptResponse)
async def get_session(
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> SessionScriptResponse:
    session = await db.scalar(select(Session).where(Session.participant_id == participant.id))
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No active run.")

    raw = await build_steps(db, participant)
    steps = [
        {"index": i, "completed": i < session.current_step_index, **s} for i, s in enumerate(raw)
    ]
    return SessionScriptResponse(
        status=participant.status.value,
        current_step_index=session.current_step_index,
        total_steps=len(raw),
        steps=steps,
    )


@router.patch("/session/progress", response_model=ProgressResult)
async def update_progress(
    body: ProgressUpdateRequest,
    background_tasks: BackgroundTasks,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> ProgressResult:
    session = await db.scalar(select(Session).where(Session.participant_id == participant.id))
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No active run.")

    raw = await build_steps(db, participant)
    total = len(raw)

    # Forward-only: a refresh or double-submit can never rewind the run.
    was_at = session.current_step_index
    target = max(0, min(body.current_step_index, total))
    if target > was_at:
        session.current_step_index = target

    # The script ends with a read-only `thanks` step that never reports its own
    # progress, so landing on it means every action step is behind us.
    closing = total - 1 if raw and raw[-1]["kind"] == "thanks" else total
    complete = session.current_step_index >= closing
    if complete and session.completed_at is None:
        session.completed_at = datetime.now(UTC)
        participant.status = ParticipantStatus.completed

    await db.commit()
    background_tasks.add_task(
        log_event,
        participant_id=participant.id,
        event_type="progress_update",
        payload=_progress_payload(raw, was_at, session.current_step_index, complete),
    )
    return ProgressResult(
        status=participant.status.value,
        current_step_index=session.current_step_index,
        total_steps=total,
        complete=complete,
    )


def _progress_payload(steps: list[dict], was_at: int, now_at: int, complete: bool) -> dict:
    """What one advance through the script records.

    The counts alone were unreadable — a row saying step 4 of 54 with nothing
    about what step 4 *was* — so the screen that was just finished and the one
    now on show travel with it. A repeated or rewinding request finishes
    nothing, and says so by leaving `completed_step` out.
    """
    payload: dict = {"current_step_index": now_at, "total_steps": len(steps), "complete": complete}
    if now_at > was_at and was_at < len(steps):
        payload["completed_step"] = describe_step(steps[was_at], was_at)
    if now_at < len(steps):
        payload["current_step"] = describe_step(steps[now_at], now_at)
    return payload


@router.get("/videos/{video_id}/url", response_model=VideoUrlResponse)
async def get_video_url(
    video_id: int,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> VideoUrlResponse:
    await _require_assigned(db, participant, video_id)
    video = await db.get(Video, video_id)
    if video is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Video not found.")

    if not video.gcp_filename:
        if settings.DEV_PLACEHOLDER_VIDEO_URL and not settings.GCP_BUCKET_NAME:
            return VideoUrlResponse(signed_url=settings.DEV_PLACEHOLDER_VIDEO_URL)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No file uploaded for this video yet.")

    if settings.GCP_BUCKET_NAME:
        try:
            from google.cloud import storage

            blob = storage.Client().bucket(settings.GCP_BUCKET_NAME).blob(video.gcp_filename)
            url = sign_blob_url(blob)
            return VideoUrlResponse(signed_url=url)
        except Exception as exc:
            logger.exception("could not sign url for %s", video.gcp_filename)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "Could not generate video URL."
            ) from exc

    return VideoUrlResponse(signed_url=f"/uploads/videos/{video.gcp_filename}")


@router.get("/videos/{video_id}/notes", response_model=list[NoteResponse])
async def get_video_notes(
    video_id: int,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> list[NoteResponse]:
    # The diagnosis and think-aloud screens read the notes back in the order
    # they were written against the clip.
    await _require_assigned(db, participant, video_id)
    rows = (
        (
            await db.execute(
                select(Note)
                .where(Note.participant_id == participant.id, Note.video_id == video_id)
                .order_by(Note.video_time_seconds, Note.id)
            )
        )
        .scalars()
        .all()
    )
    return [
        NoteResponse(
            video_time_seconds=n.video_time_seconds,
            client_ts=n.client_ts,
            text=n.text,
            created_at=n.created_at.isoformat(),
        )
        for n in rows
    ]


@router.post("/notes", response_model=IdResponse, status_code=status.HTTP_201_CREATED)
async def create_note(
    body: NoteCreate,
    background_tasks: BackgroundTasks,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> IdResponse:
    await _require_assigned(db, participant, body.video_id)
    note = Note(
        participant_id=participant.id,
        video_id=body.video_id,
        video_time_seconds=body.video_time_seconds,
        client_ts=body.client_ts,
        text=body.text,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    background_tasks.add_task(
        log_event,
        participant_id=participant.id,
        event_type="note_saved",
        video_id=body.video_id,
        payload={"video_time_seconds": body.video_time_seconds},
    )
    return IdResponse(id=note.id)


def _reject_missing(questions: list[dict], answers: dict) -> None:
    missing = missing_required_answers(questions, answers)
    if missing:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": "Please answer every required question.", "missing": missing},
        )


@router.post("/diagnosis", response_model=IdResponse, status_code=status.HTTP_201_CREATED)
async def create_diagnosis(
    body: DiagnosisCreate,
    background_tasks: BackgroundTasks,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> IdResponse:
    await _require_assigned(db, participant, body.video_id)

    ratings = await db.scalar(
        select(Questionnaire).where(
            Questionnaire.study_id == participant.study_id,
            Questionnaire.placement == QuestionnairePlacement.diagnosis,
        )
    )
    if ratings is None and body.answers:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This study has no diagnosis questions.")
    if ratings is not None:
        _reject_missing(ratings.questions, body.answers)

    # One diagnosis per case. A resubmit — after a refresh at this step, or a
    # client retrying a request whose response was lost — is the participant's
    # final answer, not a second one. The ratings are part of that answer, so
    # they are written in the same transaction and replaced the same way.
    entry = await db.scalar(
        select(TextEntry)
        .where(
            TextEntry.participant_id == participant.id,
            TextEntry.video_id == body.video_id,
            TextEntry.kind == "diagnosis",
        )
        .order_by(TextEntry.id)
    )
    if entry is None:
        entry = TextEntry(
            participant_id=participant.id,
            video_id=body.video_id,
            kind="diagnosis",
            text=body.text,
            time_spent_seconds=body.time_spent_seconds,
        )
        db.add(entry)
    else:
        entry.text = body.text
        entry.time_spent_seconds = body.time_spent_seconds

    if ratings is not None:
        await _store_answers(
            db,
            ratings,
            participant,
            body.video_id,
            body.answers,
            replace=True,
            time_spent_seconds=body.time_spent_seconds,
        )

    await db.commit()
    await db.refresh(entry)
    background_tasks.add_task(
        log_event,
        participant_id=participant.id,
        event_type="diagnosis_submitted",
        video_id=body.video_id,
        payload={"time_spent_seconds": body.time_spent_seconds},
    )
    return IdResponse(id=entry.id)


async def _store_answers(
    db: AsyncSession,
    questionnaire: Questionnaire,
    participant: Participant,
    video_id: int | None,
    answers: dict,
    *,
    replace: bool,
    time_spent_seconds: int | None = None,
) -> None:
    existing = await db.scalar(
        select(QuestionnaireResponse).where(
            QuestionnaireResponse.questionnaire_id == questionnaire.id,
            QuestionnaireResponse.participant_id == participant.id,
            QuestionnaireResponse.video_id == video_id,
        )
    )
    if existing is None:
        db.add(
            QuestionnaireResponse(
                questionnaire_id=questionnaire.id,
                participant_id=participant.id,
                video_id=video_id,
                answers=answers,
                time_spent_seconds=time_spent_seconds,
            )
        )
    elif replace:
        existing.answers = answers
        existing.time_spent_seconds = time_spent_seconds


@router.post("/questionnaires/{questionnaire_id}/respond", status_code=status.HTTP_201_CREATED)
async def respond_questionnaire(
    questionnaire_id: int,
    body: QuestionnaireRespondRequest,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    questionnaire = await db.get(Questionnaire, questionnaire_id)
    if questionnaire is None or questionnaire.study_id != participant.study_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Questionnaire not found.")

    if questionnaire.placement == QuestionnairePlacement.diagnosis:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Diagnosis ratings are submitted together with the diagnosis itself.",
        )

    # A pre-test page belongs to the run, everything else to one case; sending
    # the wrong one would file the answers where nothing looks for them.
    wants_case = questionnaire.placement != QuestionnairePlacement.pre_test
    if wants_case and body.video_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This questionnaire belongs to a case.")
    if not wants_case and body.video_id is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This questionnaire has no case.")
    if body.video_id is not None:
        await _require_assigned(db, participant, body.video_id)

    _reject_missing(questionnaire.questions, body.answers)

    # One response per case (or per run); a resume or double-submit is a no-op
    # success rather than a second row.
    await _store_answers(
        db,
        questionnaire,
        participant,
        body.video_id,
        body.answers,
        replace=False,
        time_spent_seconds=body.time_spent_seconds,
    )
    try:
        await db.commit()
    except IntegrityError:
        # A concurrent submit won the race; the unique index did its job.
        await db.rollback()
    return {"status": "ok"}


@router.post("/events", status_code=status.HTTP_202_ACCEPTED)
async def log_participant_event(
    body: EventCreate,
    background_tasks: BackgroundTasks,
    participant: Participant = Depends(get_current_participant),
) -> dict[str, str]:
    background_tasks.add_task(
        log_event,
        participant_id=participant.id,
        event_type=body.event_type,
        video_id=body.video_id,
        payload=body.payload,
        client_ts=body.client_ts,
    )
    return {"status": "accepted"}
