from __future__ import annotations

import logging
from typing import Any

from app.core.database import SessionLocal
from app.models.interaction_log import InteractionLog

logger = logging.getLogger(__name__)


async def log_event(
    participant_id: str,
    event_type: str,
    video_id: int | None = None,
    payload: dict[str, Any] | None = None,
    client_ts: int | None = None,
) -> None:
    # Fire-and-forget from a BackgroundTask, so it must open its own session
    # rather than borrow the request's.
    try:
        async with SessionLocal() as db:
            db.add(
                InteractionLog(
                    participant_id=participant_id,
                    event_type=event_type,
                    video_id=video_id,
                    payload=payload or {},
                    client_ts=client_ts,
                )
            )
            await db.commit()
    except Exception:
        logger.exception("could not log interaction event %s", event_type)
