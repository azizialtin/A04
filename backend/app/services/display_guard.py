"""Display interruptions on the participant's clock, including delayed event uploads."""

from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.interaction_log import InteractionLog
from app.services.gaze_analysis import finite_number

DISPLAY_GUARD_EVENTS = ("display_guard_interrupted", "display_guard_resumed")
DISPLAY_GUARD_PROFILE = "lab_1080p"
NATIVE_VIEWPORT_PROFILE = "native_viewport_v1"
DISPLAY_GUARD_PROFILES = (DISPLAY_GUARD_PROFILE, NATIVE_VIEWPORT_PROFILE)


@dataclass(frozen=True)
class DisplayGuardIntervals:
    ranges: tuple[tuple[float, float], ...] = ()
    starts: tuple[float, ...] = ()
    # The original fields remain the legacy profile for existing callers.
    by_profile: dict[str, DisplayGuardIntervals] = field(default_factory=dict)

    def for_profile(self, profile: str) -> DisplayGuardIntervals:
        if profile == DISPLAY_GUARD_PROFILE:
            return self
        return self.by_profile.get(profile, DisplayGuardIntervals())

    def at_or_before(self, timestamp: float) -> tuple[float, float] | None:
        index = bisect_right(self.starts, timestamp) - 1
        return self.ranges[index] if index >= 0 else None

    def interrupted(self, timestamp: float) -> bool:
        interval = self.at_or_before(timestamp)
        return interval is not None and timestamp < interval[1]


def _profile_intervals(events: Iterable[Any], profile: str) -> DisplayGuardIntervals:
    observations: dict[float, set[str]] = defaultdict(set)
    for event in events:
        if (
            event.event_type in DISPLAY_GUARD_EVENTS
            and finite_number(event.client_ts)
            and isinstance(event.payload, dict)
            and event.payload.get("profile") == profile
        ):
            observations[event.client_ts].add(event.event_type)
    ranges = []
    start = None
    for timestamp, kinds in sorted(observations.items()):
        # A simultaneous resume cannot certify the interruption at that instant.
        if "display_guard_interrupted" in kinds:
            if start is None:
                start = timestamp
        elif start is not None:
            ranges.append((start, timestamp))
            start = None
    if start is not None:
        ranges.append((start, float("inf")))
    return DisplayGuardIntervals(tuple(ranges), tuple(start for start, _ in ranges))


def display_guard_intervals(events: Iterable[Any]) -> DisplayGuardIntervals:
    rows = list(events)
    legacy = _profile_intervals(rows, DISPLAY_GUARD_PROFILE)
    native = _profile_intervals(rows, NATIVE_VIEWPORT_PROFILE)
    return DisplayGuardIntervals(
        legacy.ranges,
        legacy.starts,
        {NATIVE_VIEWPORT_PROFILE: native} if native.ranges else {},
    )


async def load_display_guard_intervals(
    db: AsyncSession, participant_ids: Sequence[str]
) -> dict[str, DisplayGuardIntervals]:
    if not participant_ids:
        return {}
    events = await db.execute(
        select(
            InteractionLog.participant_id,
            InteractionLog.event_type,
            InteractionLog.client_ts,
            InteractionLog.payload,
        ).where(
            InteractionLog.participant_id.in_(participant_ids),
            InteractionLog.event_type.in_(DISPLAY_GUARD_EVENTS),
        )
    )
    by_participant = defaultdict(list)
    for event in events:
        by_participant[event.participant_id].append(event)
    return {
        participant_id: display_guard_intervals(rows)
        for participant_id, rows in by_participant.items()
    }
