"""Durable ingestion of participant writes that the browser may retry."""

import hashlib
import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.schemas.participant import EventCreate, NoteCreate


def _same_content(previous: Any, current: Any) -> bool:
    # Python considers True equal to 1; they are distinct JSON payload values.
    if isinstance(previous, bool) != isinstance(current, bool):
        return False
    if isinstance(previous, dict) and isinstance(current, dict):
        return previous.keys() == current.keys() and all(
            _same_content(previous[key], current[key]) for key in previous
        )
    if isinstance(previous, list) and isinstance(current, list):
        return len(previous) == len(current) and all(
            _same_content(a, b) for a, b in zip(previous, current, strict=True)
        )
    return previous == current


def _note_key(body: NoteCreate) -> str | None:
    if body.request_id is not None:
        return "uuid:" + str(body.request_id)
    if body.client_ts is None:
        return None
    # Older outboxes have no UUID. Their timestamp distinguishes later snapshots
    # with the same text, even while the clip is paused.
    snapshot = body.model_dump(exclude={"request_id"})
    packed = json.dumps(snapshot, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return "snapshot:" + hashlib.sha256(packed.encode()).hexdigest()


async def save_note(db: AsyncSession, participant_id: str, body: NoteCreate) -> int:
    values = body.model_dump(exclude={"request_id"})
    key = _note_key(body)
    try:
        note_id = await db.scalar(
            insert(Note)
            .values(participant_id=participant_id, request_key=key, **values)
            .on_conflict_do_nothing(index_elements=["participant_id", "request_key"])
            .returning(Note.id)
        )
        if note_id is None:
            previous = await db.scalar(
                select(Note).where(Note.participant_id == participant_id, Note.request_key == key)
            )
            if previous is None or any(
                not _same_content(getattr(previous, field), value)
                for field, value in values.items()
            ):
                raise HTTPException(
                    409, "This note request was already used with different content."
                )
            note_id = previous.id
        else:
            db.add(
                InteractionLog(
                    participant_id=participant_id,
                    event_type="note_saved",
                    video_id=body.video_id,
                    client_ts=body.client_ts,
                    payload={"video_time_seconds": body.video_time_seconds},
                )
            )
        await db.commit()
        return note_id
    except SQLAlchemyError as exc:
        await db.rollback()
        raise HTTPException(503, "The note could not be saved. Retry the same request.") from exc


async def save_event(db: AsyncSession, participant_id: str, body: EventCreate) -> None:
    values = body.model_dump(exclude={"request_id"})
    request_id = str(body.request_id) if body.request_id is not None else None
    try:
        event_id = await db.scalar(
            insert(InteractionLog)
            .values(participant_id=participant_id, request_id=request_id, **values)
            .on_conflict_do_nothing(index_elements=["participant_id", "request_id"])
            .returning(InteractionLog.id)
        )
        if event_id is None:
            previous = await db.scalar(
                select(InteractionLog).where(
                    InteractionLog.participant_id == participant_id,
                    InteractionLog.request_id == request_id,
                )
            )
            if previous is None or any(
                not _same_content(getattr(previous, field), value)
                for field, value in values.items()
            ):
                raise HTTPException(
                    409, "This event request was already used with different content."
                )
        await db.commit()
    except SQLAlchemyError as exc:
        await db.rollback()
        raise HTTPException(503, "The event could not be saved. Retry the same request.") from exc
