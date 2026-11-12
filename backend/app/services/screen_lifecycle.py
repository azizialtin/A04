from datetime import UTC, datetime, timedelta

from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.screen_recording import ScreenRecording

BROWSER_HEARTBEAT_TIMEOUT = timedelta(minutes=3)


async def expire_browser_recordings(db: AsyncSession) -> None:
    """A crashed tab cannot report failure; stop presenting its capture as live."""
    now = datetime.now(UTC)
    await db.execute(
        update(ScreenRecording)
        .where(
            ScreenRecording.recorder == "browser",
            ScreenRecording.status == "recording",
            func.coalesce(ScreenRecording.last_seen_at, ScreenRecording.started_at)
            < now - BROWSER_HEARTBEAT_TIMEOUT,
        )
        .values(
            status="failed",
            error="Browser recording interrupted: no heartbeat for three minutes.",
            completed_at=now,
        )
    )
    await db.commit()
