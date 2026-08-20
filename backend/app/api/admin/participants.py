"""Participants and the ordered video sequence that is their personalisation."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.researcher import Researcher
from app.models.session import Session
from app.models.video import Video
from app.schemas.admin import (
    BulkAssign,
    ParticipantDetail,
    ParticipantResponse,
    ParticipantsCreate,
    SequenceAssign,
)
from app.services.storage import SAFE_ID, delete_participant_gaze, delete_participant_screens

from ._common import (
    MAX_PARTICIPANT_ID_LENGTH,
    _audit,
    _participant_or_404,
    _study_or_404,
)
from ._sequence import _assign_sequence

router = APIRouter()


@router.get("/studies/{study_id}/participants", response_model=list[ParticipantResponse])
async def list_participants(
    study_id: int,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[ParticipantResponse]:
    await _study_or_404(db, study_id)
    rows = (
        await db.execute(
            select(Participant, func.count(ParticipantVideo.id))
            .outerjoin(ParticipantVideo, ParticipantVideo.participant_id == Participant.id)
            .where(Participant.study_id == study_id)
            .group_by(Participant.id)
            .order_by(Participant.id)
        )
    ).all()
    return [
        ParticipantResponse(id=p.id, status=p.status.value, slot_count=count) for p, count in rows
    ]


@router.post("/studies/{study_id}/participants")
async def create_participants(
    study_id: int,
    body: ParticipantsCreate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[str]]:
    await _study_or_404(db, study_id)

    # Vet the whole batch before writing any of it. An id the column can't hold
    # used to blow up the insert and take every good id in the request with it.
    wanted: list[str] = []
    seen: set[str] = set()
    rejected: list[str] = []
    for raw in body.ids:
        pid = raw.strip()
        if not pid:
            continue
        if len(pid) > MAX_PARTICIPANT_ID_LENGTH or not SAFE_ID.match(pid):
            rejected.append(pid)
        elif pid.lower() not in seen:
            # Pasting the same id twice asks for one participant, not a crash.
            seen.add(pid.lower())
            wanted.append(pid)

    if rejected:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": (
                    f"Participant ids may be at most {MAX_PARTICIPANT_ID_LENGTH} characters, "
                    "using letters, digits, dot, dash and underscore."
                ),
                "ids": rejected,
            },
        )

    taken = set(
        (
            await db.execute(
                select(func.lower(Participant.id)).where(func.lower(Participant.id).in_(seen))
            )
        )
        .scalars()
        .all()
    )
    created = [pid for pid in wanted if pid.lower() not in taken]
    skipped = [pid for pid in wanted if pid.lower() in taken]

    db.add_all([Participant(id=pid, study_id=study_id) for pid in created])
    await db.commit()
    _audit(
        background_tasks,
        admin,
        "participants_created",
        {"study_id": study_id, "count": len(created)},
    )
    return {"created": created, "skipped": skipped}


@router.get("/participants/{participant_id}", response_model=ParticipantDetail)
async def participant_detail(
    participant_id: str,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> ParticipantDetail:
    p = await _participant_or_404(db, participant_id)
    session = await db.scalar(select(Session).where(Session.participant_id == p.id))
    rows = (
        await db.execute(
            select(ParticipantVideo, Video.title)
            .join(Video, Video.id == ParticipantVideo.video_id)
            .where(ParticipantVideo.participant_id == p.id)
            .order_by(ParticipantVideo.slot_index)
        )
    ).all()
    sequence = [
        {
            "slot_index": pv.slot_index,
            "video_id": pv.video_id,
            "video_title": title,
            "phase_type": pv.phase_type.value,
        }
        for pv, title in rows
    ]
    return ParticipantDetail(
        id=p.id,
        status=p.status.value,
        current_step_index=session.current_step_index if session else None,
        sequence=sequence,
    )


@router.delete("/participants/{participant_id}")
async def delete_participant(
    participant_id: str,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    p = await _participant_or_404(db, participant_id)
    await db.delete(p)
    await db.commit()
    # Their gaze and the recording of their screen are the most sensitive things
    # we hold; an erasure that left either on disk would not be one.
    settings = get_settings()
    await run_in_threadpool(delete_participant_gaze, p.id, settings)
    await run_in_threadpool(delete_participant_screens, p.id, settings)
    _audit(background_tasks, admin, "participant_deleted", {"participant_id": participant_id})
    return {"status": "ok"}


@router.put("/participants/{participant_id}/videos")
async def set_sequence(
    participant_id: str,
    body: SequenceAssign,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    p = await _participant_or_404(db, participant_id)
    if p.status.value != "registered":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Participant has already started; sequence is locked."
        )
    await _assign_sequence(db, p, body.items)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Invalid sequence (duplicate slot?)."
        ) from None
    _audit(background_tasks, admin, "sequence_set", {"participant_id": participant_id})
    return {"status": "ok", "slot_count": len(body.items)}


@router.post("/studies/{study_id}/bulk-assign")
async def bulk_assign(
    study_id: int,
    body: BulkAssign,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[str]]:
    await _study_or_404(db, study_id)

    # One query for the lot, rather than one per participant.
    found = {
        p.id: p
        for p in (
            await db.execute(
                select(Participant).where(
                    Participant.id.in_(set(body.participant_ids)),
                    Participant.study_id == study_id,
                )
            )
        ).scalars()
    }

    applied: list[str] = []
    skipped: list[str] = []
    for pid in body.participant_ids:
        p = found.get(pid)
        if p is None or p.status.value != "registered":
            skipped.append(pid)
            continue
        await _assign_sequence(db, p, body.items)
        applied.append(pid)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Invalid sequence (duplicate slot?)."
        ) from None
    _audit(background_tasks, admin, "bulk_assign", {"study_id": study_id, "count": len(applied)})
    return {"applied": applied, "skipped": skipped}
