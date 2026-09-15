"""Dealing a participant one of the study's video sets.

The study runs two fixed video orders and wants half of the participants on
each. Pure chance does not deliver that on forty people, so the deal is
balanced: whichever set has been given out least often gets the next
participant, and a tie is settled by a coin toss. On an even count the split is
exact; the first of each pair is still random.

It happens at first login rather than when the participant is created, so that
the balance is over the people who actually turned up — an id printed on a
sheet and never used would otherwise count as half of a pair.
"""

from __future__ import annotations

import random
from collections.abc import Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.study import Study
from app.models.video import Video
from app.models.video_set import VideoSet, VideoSetItem

# Swapped out by tests that want a predictable tie-break.
rng = random.SystemRandom()


async def study_sets(db: AsyncSession, study_id: int) -> list[VideoSet]:
    return list(
        (
            await db.execute(
                select(VideoSet).where(VideoSet.study_id == study_id).order_by(VideoSet.id)
            )
        )
        .scalars()
        .all()
    )


async def set_items(db: AsyncSession, video_set_id: int) -> list[tuple[VideoSetItem, Video]]:
    """The set's slots in order, each with its video."""
    rows = (
        await db.execute(
            select(VideoSetItem, Video)
            .join(Video, Video.id == VideoSetItem.video_id)
            .where(VideoSetItem.video_set_id == video_set_id)
            .order_by(VideoSetItem.slot_index)
        )
    ).all()
    return [(item, video) for item, video in rows]


async def participants_per_set(db: AsyncSession, study_id: int) -> dict[int, int]:
    """How many participants each of the study's sets has been dealt to."""
    rows = (
        await db.execute(
            select(VideoSet.id, func.count(Participant.id))
            .outerjoin(Participant, Participant.video_set_id == VideoSet.id)
            .where(VideoSet.study_id == study_id)
            .group_by(VideoSet.id)
        )
    ).all()
    return {int(set_id): int(count) for set_id, count in rows}


async def _dealable(db: AsyncSession, study_id: int) -> list[VideoSet]:
    """Sets with at least one video in them. An empty set would hand the
    participant an empty run, which the script would silently replace with the
    study default — so it is skipped rather than dealt."""
    filled = set(
        (
            await db.execute(
                select(VideoSetItem.video_set_id)
                .join(VideoSet, VideoSet.id == VideoSetItem.video_set_id)
                .where(VideoSet.study_id == study_id)
                .distinct()
            )
        )
        .scalars()
        .all()
    )
    return [s for s in await study_sets(db, study_id) if s.id in filled]


def pick_balanced(sets: Sequence[VideoSet], counts: dict[int, int]) -> VideoSet | None:
    """The least-dealt set; a tie goes to whichever the coin says."""
    if not sets:
        return None
    fewest = min(counts.get(s.id, 0) for s in sets)
    candidates = [s for s in sets if counts.get(s.id, 0) == fewest]
    # The coin only comes out for a real tie.
    return candidates[0] if len(candidates) == 1 else rng.choice(candidates)


async def apply_set(db: AsyncSession, participant: Participant, video_set: VideoSet) -> int:
    """Copy the set into the participant's own sequence and remember which set
    it was. Returns how many slots that is."""
    items = await set_items(db, video_set.id)
    await db.execute(
        delete(ParticipantVideo).where(ParticipantVideo.participant_id == participant.id)
    )
    for item, _video in items:
        db.add(
            ParticipantVideo(
                participant_id=participant.id,
                video_id=item.video_id,
                slot_index=item.slot_index,
                phase_type=item.phase_type,
            )
        )
    participant.video_set_id = video_set.id
    return len(items)


async def deal_on_first_login(db: AsyncSession, participant: Participant) -> VideoSet | None:
    """Give a participant with no sequence of their own one of the study's sets.

    Nothing happens when the researcher has hand-picked their run — that is the
    personalisation and it wins — or when the study has no filled set, in which
    case the script falls back to the study's videos as before. Returns the set
    dealt, if any. Caller commits.
    """
    # Two participants logging in at the same moment would both see the same
    # counts and could both take the same set; a participant who double-clicked
    # Login would race themselves. Holding the study row until the commit makes
    # the second one wait — and every read this decides on has to happen after
    # it, or the lock is decoration.
    await db.execute(select(Study.id).where(Study.id == participant.study_id).with_for_update())

    has_sequence = await db.scalar(
        select(ParticipantVideo.id)
        .where(ParticipantVideo.participant_id == participant.id)
        .limit(1)
    )
    if has_sequence is not None:
        return None

    sets = await _dealable(db, participant.study_id)
    chosen = pick_balanced(sets, await participants_per_set(db, participant.study_id))
    if chosen is None:
        return None
    await apply_set(db, participant, chosen)
    return chosen
