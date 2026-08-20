"""Assigning a participant their ordered run, shared by the single and bulk
endpoints."""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gaze_recording import GazeRecording
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.screen_recording import ScreenRecording
from app.models.video import Video
from app.schemas.admin import SequenceItem

from ._common import _phase


async def _recording_owners(db: AsyncSession, model, **where) -> list[tuple[str, int]]:
    """(participant_id, recording_id) for the recordings about to be deleted, so
    their files can be removed once the rows are gone. `model` is whichever kind
    of recording — gaze chunks and screen captures are stored the same way."""
    q = select(model.participant_id, model.id)
    if "video_ids" in where:
        q = q.where(model.video_id.in_(where["video_ids"]))
    if "participant_id" in where:
        q = q.where(model.participant_id == where["participant_id"])
    return [(pid, rid) for pid, rid in (await db.execute(q)).all()]


async def _gaze_owners(db: AsyncSession, **where) -> list[tuple[str, int]]:
    return await _recording_owners(db, GazeRecording, **where)


async def _screen_owners(db: AsyncSession, **where) -> list[tuple[str, int]]:
    return await _recording_owners(db, ScreenRecording, **where)


async def _assign_sequence(
    db: AsyncSession, participant: Participant, items: list[SequenceItem]
) -> None:
    video_ids = {i.video_id for i in items}
    if video_ids:
        found = set(
            (
                await db.execute(
                    select(Video.id).where(
                        Video.id.in_(video_ids), Video.study_id == participant.study_id
                    )
                )
            )
            .scalars()
            .all()
        )
        missing = video_ids - found
        if missing:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Videos not in this study: {sorted(missing)}"
            )
    await db.execute(
        delete(ParticipantVideo).where(ParticipantVideo.participant_id == participant.id)
    )
    for it in items:
        db.add(
            ParticipantVideo(
                participant_id=participant.id,
                video_id=it.video_id,
                slot_index=it.slot_index,
                phase_type=_phase(it.phase_type),
            )
        )
