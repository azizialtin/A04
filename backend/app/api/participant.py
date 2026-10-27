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
from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.session import Session
from app.models.study import Study
from app.models.text_entry import TextEntry
from app.models.video import Video
from app.schemas.participant import (
    DiagnosisCreate,
    EventCreate,
    FinishCkRequest,
    IdResponse,
    NoteCreate,
    NoteResponse,
    ParticipantMeResponse,
    ProgressResult,
    ProgressUpdateRequest,
    QuestionnaireRespondRequest,
    QuestionnaireVisitRequest,
    QuestionnaireVisitResponse,
    SessionScriptResponse,
    StepBackRequest,
    VideoUrlResponse,
)
from app.services.event_logger import log_event
from app.services.questionnaires import invalid_partial_answers, missing_required_answers
from app.services.section_timing import (
    CK_SECONDS,
    CK_SECTION,
    ck_attempt,
    close_visit,
    end_attempt,
    get_visit,
    lock_session,
    now_ms,
    timing_response,
)
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
    steps = []
    for i, step in enumerate(raw):
        passed = i < session.current_step_index
        skipped = (
            passed
            and step["kind"] == "questionnaire"
            and step.get("section_key") == CK_SECTION
            and step.get("previous_answers") is None
        )
        steps.append({"index": i, "completed": passed and not skipped, "skipped": skipped, **step})
    return SessionScriptResponse(
        status=participant.status.value,
        current_step_index=session.current_step_index,
        total_steps=len(raw),
        steps=steps,
        section_timing=timing_response(await ck_attempt(db, participant.id)),
    )


@router.post("/session/questionnaire-visit", response_model=QuestionnaireVisitResponse)
async def enter_questionnaire(
    body: QuestionnaireVisitRequest,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> QuestionnaireVisitResponse:
    session = await lock_session(db, participant.id)
    raw = await build_steps(db, participant)
    if body.step_index != session.current_step_index or body.step_index >= len(raw):
        raise HTTPException(409, "The current page has changed. Reload the session.")
    step = raw[body.step_index]
    if (
        step["kind"] != "questionnaire"
        or step.get("questionnaire_id") != body.questionnaire_id
        or not step.get("section_key")
    ):
        raise HTTPException(409, "This page does not record section visits.")
    visit = await db.get(QuestionnaireVisit, str(body.visit_id))
    if visit is not None:
        if (
            visit.participant_id != participant.id
            or visit.questionnaire_id != body.questionnaire_id
            or visit.step_index != body.step_index
        ):
            raise HTTPException(409, "This visit identity is already in use.")
        return QuestionnaireVisitResponse(
            visit_id=visit.id, section_timing=timing_response(await ck_attempt(db, participant.id))
        )
    attempt = await ck_attempt(db, participant.id)
    if step["section_key"] == CK_SECTION and attempt is None:
        attempt = SectionAttempt(
            participant_id=participant.id,
            section_key=CK_SECTION,
            section=step["section"] or step["title"],
            started_client_ts=body.client_ts,
            deadline_ms=now_ms() + CK_SECONDS * 1000,
        )
        db.add(attempt)
    visit = QuestionnaireVisit(
        id=str(body.visit_id),
        participant_id=participant.id,
        questionnaire_id=body.questionnaire_id,
        section_key=step["section_key"],
        step_index=body.step_index,
        entered_client_ts=body.client_ts,
        is_review=bool(
            attempt and attempt.ended_client_ts is not None and step["section_key"] == CK_SECTION
        ),
    )
    db.add(visit)
    await db.commit()
    return QuestionnaireVisitResponse(visit_id=visit.id, section_timing=timing_response(attempt))


@router.post("/session/finish-ck", response_model=ProgressResult)
async def finish_ck(
    body: FinishCkRequest,
    background_tasks: BackgroundTasks,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> ProgressResult:
    session = await lock_session(db, participant.id)
    raw = await build_steps(db, participant)
    visit = await get_visit(db, participant.id, str(body.visit_id))
    if visit.finish_request_id == str(body.request_id):
        if (
            visit.submitted_answers != body.answers
            or visit.exited_client_ts != body.client_ts
            or visit.step_index != body.expected_step_index
        ):
            raise HTTPException(409, "A retry must match the original section finish.")
        return ProgressResult(
            status=participant.status.value,
            current_step_index=session.current_step_index,
            total_steps=len(raw),
            complete=False,
        )
    index = session.current_step_index
    if index != body.expected_step_index or index >= len(raw):
        raise HTTPException(409, "The current page has changed. Reload the session.")
    step = raw[index]
    if step["kind"] != "questionnaire" or step.get("section_key") != CK_SECTION:
        raise HTTPException(409, "Only a CK task can finish the CK section.")
    if (
        visit.questionnaire_id != step["questionnaire_id"]
        or visit.step_index != index
        or visit.exited_client_ts is not None
    ):
        raise HTTPException(409, "This page visit is no longer active.")
    target = next(
        (
            i
            for i in range(index + 1, len(raw))
            if raw[i].get("section_key") == "pck"
            and raw[i]["kind"] in ("section_intro", "questionnaire")
        ),
        None,
    )
    if target is None:
        raise HTTPException(
            409, "No PCK section follows the CK tasks. Ask the supervisor to check the study."
        )
    invalid = invalid_partial_answers(step["questions"], body.answers)
    if invalid:
        raise HTTPException(422, {"message": "Some answers are invalid.", "missing": invalid})
    questionnaire = await db.get(Questionnaire, step["questionnaire_id"])
    assert questionnaire is not None
    seconds = close_visit(visit, body.client_ts, "supervisor_finish")
    visit.submitted_answers = body.answers
    visit.finish_request_id = str(body.request_id)
    await _store_answers(
        db,
        questionnaire,
        participant,
        None,
        body.answers,
        replace=True,
        time_spent_seconds=seconds,
        response_status="partial",
    )
    end_attempt(await ck_attempt(db, participant.id), body.client_ts, "supervisor_finish")
    session.current_step_index = target
    await db.commit()
    background_tasks.add_task(
        log_event,
        participant_id=participant.id,
        event_type="admin_finish_ck",
        client_ts=body.client_ts,
        payload={
            "left_step": describe_step(step, index),
            "current_step": describe_step(raw[target], target),
            "visit_id": visit.id,
            "skipped_questionnaire_ids": [
                s["questionnaire_id"]
                for s in raw[index + 1 : target]
                if s["kind"] == "questionnaire" and s.get("section_key") == CK_SECTION
            ],
        },
    )
    return ProgressResult(
        status=participant.status.value,
        current_step_index=target,
        total_steps=len(raw),
        complete=False,
    )


@router.patch("/session/progress", response_model=ProgressResult)
async def update_progress(
    body: ProgressUpdateRequest,
    background_tasks: BackgroundTasks,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> ProgressResult:
    session = await lock_session(db, participant.id)

    raw = await build_steps(db, participant)
    total = len(raw)

    # Forward-only: a refresh or double-submit can never rewind the run.
    was_at = session.current_step_index
    target = max(0, min(body.current_step_index, total))
    if (
        body.expected_step_index is not None
        and body.expected_step_index != was_at
        and target != was_at
    ):
        raise HTTPException(409, "The current page has changed. Reload the session.")
    if target > was_at:
        session.current_step_index = target
        if (
            was_at < total
            and raw[was_at].get("section_key") == CK_SECTION
            and (target >= total or raw[target].get("section_key") != CK_SECTION)
        ):
            attempt = await ck_attempt(db, participant.id)
            client_ts = body.client_ts
            if client_ts is None:
                client_ts = await db.scalar(
                    select(QuestionnaireVisit.exited_client_ts)
                    .where(
                        QuestionnaireVisit.participant_id == participant.id,
                        QuestionnaireVisit.step_index == was_at,
                        QuestionnaireVisit.exited_client_ts.is_not(None),
                    )
                    .order_by(QuestionnaireVisit.exited_client_ts.desc())
                    .limit(1)
                )
            if client_ts is not None:
                end_attempt(attempt, client_ts, "completed")

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
        client_ts=body.client_ts,
        payload=_progress_payload(raw, was_at, session.current_step_index, complete),
    )
    return ProgressResult(
        status=participant.status.value,
        current_step_index=session.current_step_index,
        total_steps=total,
        complete=complete,
    )


@router.post("/session/step-back", response_model=ProgressResult)
async def step_back(
    background_tasks: BackgroundTasks,
    body: StepBackRequest | None = None,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> ProgressResult:
    """One screen back, for the person supervising the run.

    The script is forward-only for the participant; this is the exception the
    researchers asked for, behind a key combination and a confirmation on the
    screen. The pointer moves one step and nothing is deleted: a page answered
    again overwrites its answers, a case played again records again. The move
    is logged so the data shows where a run doubled back.
    """
    session = await lock_session(db, participant.id)
    was_at = session.current_step_index
    if was_at <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Already at the first step.")

    raw = await build_steps(db, participant)
    # A pointer past the end — a finished run — comes back onto the last screen.
    target = min(was_at, len(raw)) - 1
    if body and body.visit_id and body.client_ts is not None:
        visit = await get_visit(db, participant.id, str(body.visit_id))
        if visit.step_index != was_at:
            raise HTTPException(409, "Page visit does not match the current page.")
        close_visit(visit, body.client_ts, "step_back")
    session.current_step_index = target
    await db.commit()
    background_tasks.add_task(
        log_event,
        participant_id=participant.id,
        event_type="admin_step_back",
        payload={
            "current_step_index": target,
            "total_steps": len(raw),
            "left_step": describe_step(raw[was_at], was_at) if was_at < len(raw) else None,
            "current_step": describe_step(raw[target], target),
        },
    )
    return ProgressResult(
        status=participant.status.value,
        current_step_index=target,
        total_steps=len(raw),
        complete=False,
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
    response_status: str = "submitted",
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
                response_status=response_status,
            )
        )
    elif replace:
        existing.answers = answers
        existing.time_spent_seconds = time_spent_seconds
        existing.response_status = response_status


@router.post("/questionnaires/{questionnaire_id}/respond", status_code=status.HTTP_201_CREATED)
async def respond_questionnaire(
    questionnaire_id: int,
    body: QuestionnaireRespondRequest,
    background_tasks: BackgroundTasks,
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
    if questionnaire.section_key and not wants_case and body.visit_id is None:
        raise HTTPException(422, "This section page needs its visit identity and timestamp.")
    if body.advance and (wants_case or body.visit_id is None):
        raise HTTPException(422, "Only a visited pre-test page can advance with its answers.")

    _reject_missing(questionnaire.questions, body.answers)

    progress_payload = None
    if body.visit_id is not None:
        session = await lock_session(db, participant.id)
        visit = await get_visit(db, participant.id, str(body.visit_id), questionnaire_id)
        if body.client_ts is None:
            raise HTTPException(422, "A timed page submission needs its client timestamp.")
        if visit.exited_client_ts is not None:
            if visit.exit_reason == "submitted" and visit.submitted_answers == body.answers:
                return {"status": "ok"}
            raise HTTPException(409, "This page visit is already closed.")
        if visit.step_index != session.current_step_index:
            raise HTTPException(409, "The current page has changed.")
        if body.advance:
            raw = await build_steps(db, participant)
            index = session.current_step_index
            if (
                index >= len(raw)
                or raw[index].get("questionnaire_id") != questionnaire_id
                or raw[index]["kind"] != "questionnaire"
            ):
                raise HTTPException(409, "The current page has changed.")
            target = index + 1
            if questionnaire.section_key == CK_SECTION and (
                target >= len(raw) or raw[target].get("section_key") != CK_SECTION
            ):
                end_attempt(await ck_attempt(db, participant.id), body.client_ts, "completed")
            session.current_step_index = target
            progress_payload = _progress_payload(raw, index, target, False)
        body.time_spent_seconds = close_visit(visit, body.client_ts, "submitted")
        visit.submitted_answers = body.answers

    # One response per case (or per run); a resume or double-submit is a no-op
    # success rather than a second row.
    await _store_answers(
        db,
        questionnaire,
        participant,
        body.video_id,
        body.answers,
        # The latest answer is the answer: the supervisor can step a run back onto a page.
        replace=True,
        time_spent_seconds=body.time_spent_seconds,
    )
    try:
        await db.commit()
    except IntegrityError:
        # A concurrent submit won the race; the unique index did its job.
        await db.rollback()
        if body.visit_id is not None:
            raise HTTPException(
                409, "The page could not be saved. Retry with the same answers."
            ) from None
    if progress_payload is not None:
        background_tasks.add_task(
            log_event,
            participant_id=participant.id,
            event_type="progress_update",
            payload=progress_payload,
            client_ts=body.client_ts,
        )
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
