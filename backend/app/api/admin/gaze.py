"""Looking at what was recorded of a case, from the researcher's side.

Listed per (participant, case) rather than per gaze recording: a session with
no tracker — a machine whose bridge was down, where the page captured its own
screen — produces no gaze rows at all, and keying the list on those would leave
its recordings in the bucket with nothing in the app able to find them.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.gaze_recording import GazeRecording
from app.models.participant import Participant
from app.models.researcher import Researcher
from app.models.screen_recording import ScreenRecording
from app.models.video import Video
from app.services.gaze_replay import compute_replay, compute_screen_replay
from app.services.video_url import resolve_screen_url, resolve_video_url

router = APIRouter()


@router.get("/gaze/recordings")
async def list_gaze_recordings(
    study_id: int | None = Query(None),
    participant_id: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[dict]]:
    q = (
        select(GazeRecording, Video.title)
        .join(Video, Video.id == GazeRecording.video_id)
        .join(Participant, Participant.id == GazeRecording.participant_id)
        .order_by(GazeRecording.started_at.desc())
        .limit(limit)
    )
    if study_id is not None:
        q = q.where(Participant.study_id == study_id)
    if participant_id:
        q = q.where(func.lower(GazeRecording.participant_id) == participant_id.strip().lower())
    rows = (await db.execute(q)).all()
    screens = await _screens_for(db, [(r.participant_id, r.video_id) for r, _ in rows])
    items = [
        {
            # What to ask for the replay: the gaze recording where there is
            # one, else the capture on its own.
            "replay": {"kind": "gaze", "id": r.id},
            "participant_id": r.participant_id,
            "video_id": r.video_id,
            "video_title": title,
            "sample_count": r.sample_count,
            "sampling_rate_hz": r.sampling_rate_hz,
            "started_at": r.started_at.isoformat(),
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            # Whether the replay for this case has a screen capture behind
            # it, so a failed one is visible rather than just quietly absent.
            "screen": screens.get((r.participant_id, r.video_id)),
        }
        for r, title in rows
    ]
    items.extend(
        await _screen_only_rows(
            db, study_id, participant_id, {(r.participant_id, r.video_id) for r, _ in rows}, limit
        )
    )
    items.sort(key=lambda row: row["started_at"], reverse=True)
    return {"items": items[:limit]}


async def _screen_only_rows(
    db: AsyncSession,
    study_id: int | None,
    participant_id: str | None,
    covered: set[tuple[str, int]],
    limit: int,
) -> list[dict]:
    """Cases whose screen was captured but whose eyes were not.

    The whole reason the browser fallback exists is a session without a bridge,
    and such a session has no gaze recording to hang the row on.
    """
    q = (
        select(ScreenRecording, Video.title)
        .join(Video, Video.id == ScreenRecording.video_id)
        .join(Participant, Participant.id == ScreenRecording.participant_id)
        .order_by(ScreenRecording.started_at.desc())
        .limit(limit)
    )
    if study_id is not None:
        q = q.where(Participant.study_id == study_id)
    if participant_id:
        q = q.where(func.lower(ScreenRecording.participant_id) == participant_id.strip().lower())

    seen: set[tuple[str, int]] = set()
    rows = []
    for s, title in (await db.execute(q)).all():
        key = (s.participant_id, s.video_id)
        if key in covered or key in seen:
            continue
        seen.add(key)
        rows.append(
            {
                "replay": {"kind": "screen", "id": s.id},
                "participant_id": s.participant_id,
                "video_id": s.video_id,
                "video_title": title,
                "sample_count": 0,
                "sampling_rate_hz": 0,
                "started_at": s.started_at.isoformat(),
                "completed_at": s.completed_at.isoformat() if s.completed_at else None,
                "screen": {
                    "id": s.id,
                    "status": s.status,
                    "error": s.error,
                    "duration_ms": s.duration_ms,
                    "byte_size": s.byte_size,
                    "recorder": s.recorder,
                },
            }
        )
    return rows


async def _screens_for(
    db: AsyncSession, keys: list[tuple[str, int]]
) -> dict[tuple[str, int], dict]:
    """The newest screen capture per (participant, video), for a page of rows."""
    if not keys:
        return {}
    rows = (
        (
            await db.execute(
                select(ScreenRecording)
                .where(
                    ScreenRecording.participant_id.in_({p for p, _ in keys}),
                    ScreenRecording.video_id.in_({v for _, v in keys}),
                )
                .order_by(ScreenRecording.started_at)
            )
        )
        .scalars()
        .all()
    )
    # Ascending order, so the last write per key is the newest.
    return {
        (s.participant_id, s.video_id): {
            "id": s.id,
            "status": s.status,
            "error": s.error,
            "duration_ms": s.duration_ms,
            "byte_size": s.byte_size,
            "recorder": s.recorder,
        }
        for s in rows
    }


async def _newest_screen(db: AsyncSession, participant_id: str, video_id: int):
    return await db.scalar(
        select(ScreenRecording)
        .where(
            ScreenRecording.participant_id == participant_id,
            ScreenRecording.video_id == video_id,
            ScreenRecording.status == "stored",
            ScreenRecording.epoch_ms.is_not(None),
        )
        .order_by(ScreenRecording.started_at.desc())
    )


@router.get("/screen-recordings/{recording_id}/replay")
async def admin_screen_replay(
    recording_id: int,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """A capture with no gaze recording behind it — the bridge-less session.

    The picture is the whole point of the think-aloud, so it is worth watching
    on its own; there is simply no dot on top of it.
    """
    screen = await db.get(ScreenRecording, recording_id)
    if screen is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found.")
    settings = get_settings()
    video = await db.get(Video, screen.video_id)

    url = None
    if screen.status == "stored" and screen.epoch_ms is not None:
        try:
            url = resolve_screen_url(screen, settings)
        except Exception:
            url = None
    if url is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That capture has no playable file.")

    data = await compute_screen_replay(None, screen, settings)
    return {
        "recording_id": screen.id,
        "participant_id": screen.participant_id,
        "video_id": screen.video_id,
        "video_title": video.title if video else "",
        "video_url": url,
        "source": "screen",
        "epoch_ms": screen.epoch_ms,
        "duration_ms": screen.duration_ms,
        "recorder": screen.recorder,
        "sampling_rate_hz": 0,
        "plotted_points": data["mapped_samples"],
        "invalid_samples": data["invalid_samples"],
        "unmapped_samples": data["unmapped_samples"],
        "offscreen_samples": data["offscreen_samples"],
        "has_geometry": data["has_geometry"],
        "points": data["points"],
    }


@router.get("/gaze/recordings/{recording_id}/replay")
async def admin_gaze_replay(
    recording_id: int,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    rec = await db.get(GazeRecording, recording_id)
    if rec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found.")
    video = await db.get(Video, rec.video_id)
    settings = get_settings()

    # Same preference as the participant's own think-aloud: the screen capture
    # if there is one, because it is what they actually narrated.
    screen = await _newest_screen(db, rec.participant_id, rec.video_id)
    source, url, epoch_ms, duration_ms = "clip", None, None, None
    recorder = None
    if screen is not None:
        try:
            url = resolve_screen_url(screen, settings)
        except Exception:
            url = None
        if url:
            source, epoch_ms, duration_ms = "screen", screen.epoch_ms, screen.duration_ms
            recorder = screen.recorder
            data = await compute_screen_replay(rec, screen, settings)
    if source == "clip":
        try:
            url = resolve_video_url(video, settings) if video else None
        except Exception:
            url = None
        data = await compute_replay(db, rec, settings)

    return {
        "recording_id": rec.id,
        "participant_id": rec.participant_id,
        "video_id": rec.video_id,
        "video_title": video.title if video else "",
        "video_url": url or "",
        "source": source,
        "epoch_ms": epoch_ms,
        "duration_ms": duration_ms,
        "recorder": recorder,
        "sampling_rate_hz": rec.sampling_rate_hz,
        "plotted_points": data["mapped_samples"],
        "invalid_samples": data["invalid_samples"],
        "unmapped_samples": data["unmapped_samples"],
        "offscreen_samples": data["offscreen_samples"],
        "has_geometry": data["has_geometry"],
        "points": data["points"],
    }
