"""The study's video sets: the fixed orders a participant is dealt one of."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.researcher import Researcher
from app.models.video_set import VideoSet, VideoSetItem
from app.schemas.admin import (
    SequenceItem,
    VideoSetCreate,
    VideoSetItemOut,
    VideoSetOut,
    VideoSetUpdate,
)
from app.services.video_sets import participants_per_set, set_items, study_sets

from ._common import _audit, _phase, _study_or_404
from ._sequence import _require_study_videos, reject_repeated_videos

router = APIRouter()


async def _set_or_404(db: AsyncSession, set_id: int) -> VideoSet:
    video_set = await db.get(VideoSet, set_id)
    if video_set is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Video set not found.")
    return video_set


async def _out(db: AsyncSession, video_set: VideoSet, counts: dict[int, int]) -> VideoSetOut:
    return VideoSetOut(
        id=video_set.id,
        study_id=video_set.study_id,
        name=video_set.name,
        items=[
            VideoSetItemOut(
                slot_index=item.slot_index,
                video_id=item.video_id,
                video_title=video.title,
                phase_type=item.phase_type.value,
            )
            for item, video in await set_items(db, video_set.id)
        ],
        participant_count=counts.get(video_set.id, 0),
    )


def _checked_name(name: str) -> str:
    """`min_length` runs before the strip, so a name of spaces gets this far."""
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A set needs a name.")
    return cleaned


async def _replace_items(db: AsyncSession, video_set: VideoSet, items: list[SequenceItem]) -> None:
    reject_repeated_videos(items)
    await _require_study_videos(db, video_set.study_id, {i.video_id for i in items})
    await db.execute(delete(VideoSetItem).where(VideoSetItem.video_set_id == video_set.id))
    for it in items:
        db.add(
            VideoSetItem(
                video_set_id=video_set.id,
                video_id=it.video_id,
                slot_index=it.slot_index,
                phase_type=_phase(it.phase_type),
            )
        )


async def _commit_or_400(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Invalid video set (duplicate slot, or a name this study already uses?).",
        ) from None


@router.get("/studies/{study_id}/video-sets", response_model=list[VideoSetOut])
async def list_video_sets(
    study_id: int,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[VideoSetOut]:
    await _study_or_404(db, study_id)
    counts = await participants_per_set(db, study_id)
    return [await _out(db, s, counts) for s in await study_sets(db, study_id)]


@router.post(
    "/studies/{study_id}/video-sets",
    response_model=VideoSetOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_video_set(
    study_id: int,
    body: VideoSetCreate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> VideoSetOut:
    await _study_or_404(db, study_id)
    video_set = VideoSet(study_id=study_id, name=_checked_name(body.name))
    db.add(video_set)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "This study already has a set with that name."
        ) from None
    await _replace_items(db, video_set, body.items)
    await _commit_or_400(db)
    _audit(background_tasks, admin, "video_set_created", {"video_set_id": video_set.id})
    return await _out(db, video_set, await participants_per_set(db, study_id))


@router.put("/video-sets/{set_id}", response_model=VideoSetOut)
async def update_video_set(
    set_id: int,
    body: VideoSetUpdate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> VideoSetOut:
    """Rename a set or replace its order.

    Participants already dealt this set keep the copy they were given: a run
    that has started is not changed under anyone. The edit shows up for the
    next first login.
    """
    video_set = await _set_or_404(db, set_id)
    if body.name is not None:
        video_set.name = _checked_name(body.name)
    if body.items is not None:
        await _replace_items(db, video_set, body.items)
    await _commit_or_400(db)
    _audit(background_tasks, admin, "video_set_updated", {"video_set_id": video_set.id})
    return await _out(db, video_set, await participants_per_set(db, video_set.study_id))


@router.delete("/video-sets/{set_id}")
async def delete_video_set(
    set_id: int,
    background_tasks: BackgroundTasks,
    force: bool = Query(False),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Delete a set. Participants who were dealt it keep their sequence but
    lose the label — and that label is the condition the whole study is
    analysed against, so deleting a set anyone ran is refused unless asked
    for twice."""
    video_set = await _set_or_404(db, set_id)
    dealt = (await participants_per_set(db, video_set.study_id)).get(set_id, 0)
    if dealt and not force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{dealt} participant(s) were dealt this set; deleting it loses that "
            "record of which one they ran. Pass force=true to delete it anyway.",
        )
    await db.delete(video_set)
    await db.commit()
    _audit(background_tasks, admin, "video_set_deleted", {"video_set_id": set_id})
    return {"status": "ok"}
