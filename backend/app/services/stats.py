"""What the raw log adds up to, per participant and per case.

The counting the admin statistics do is mostly SQL — a `GROUP BY` says how many
notes were written and how many samples were captured. Two things it cannot
say, because they live in the *order* of the interaction log rather than in any
one row: how long the clip was actually playing, and how long the case screen
was in front of the participant. Both are spans between paired events, and both
are reconstructed here.

Playing time comes from the same span reconstruction the gaze replay uses, so a
figure a researcher reads on the statistics page and the timeline they scrub in
the replay are derived from one implementation.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from app.services.gaze_replay import PLAYBACK_EVENTS, event_ms, playback_segments

# Everything one case summary is built from: the playback events, plus the two
# that bracket the time the case screen was on the participant's display.
CASE_EVENTS: tuple[str, ...] = (
    *PLAYBACK_EVENTS,
    "case_screen_entered",
    "case_screen_exited",
)

EMPTY_CASE: dict[str, Any] = {
    "watch_seconds": 0.0,
    "on_screen_seconds": 0.0,
    "max_playhead_seconds": 0.0,
    "play_spans": 0,
}


def _playhead_seconds(event: Any) -> float:
    payload = getattr(event, "payload", None) or {}
    try:
        return float(payload.get("currentTime", 0.0))
    except (TypeError, ValueError):
        return 0.0


def summarise_case(events: Iterable[Any]) -> dict[str, Any]:
    """One participant's time on one case, from their event rows.

    Rows need `.event_type`, `.payload` and either `.client_ts` or
    `.created_at` — the same duck type `gaze_replay` reads, so a mapped
    `InteractionLog` and a selected row tuple both work.

    `watch_seconds` is time the clip was playing; `on_screen_seconds` is time
    the case screen was up, which includes reading the task, opening the
    dialogs and typing notes with the clip paused. The gap between the two is
    itself worth looking at, which is why both are returned.
    """
    ordered = sorted(events, key=event_ms)
    if not ordered:
        return dict(EMPTY_CASE)

    # A span left open — a run still in progress, or a browser closed on the
    # case — is closed at the last thing we saw rather than left running to
    # infinity, which is what `playback_segments` does with no bound.
    end_ms = event_ms(ordered[-1])
    segments = playback_segments([e for e in ordered if e.event_type in PLAYBACK_EVENTS], end_ms)
    watch_ms = sum(end - start for start, end, _ in segments)

    # How far into the clip they ever got: the furthest playhead any event
    # reported, and the end of any span that ran on past it.
    reached_ms = max((_playhead_seconds(e) * 1000.0 for e in ordered), default=0.0)
    for start, end, video_start in segments:
        reached_ms = max(reached_ms, video_start + (end - start))

    on_screen_ms = 0.0
    entered: float | None = None
    for event in ordered:
        if event.event_type == "case_screen_entered":
            entered = event_ms(event)
        elif event.event_type == "case_screen_exited" and entered is not None:
            on_screen_ms += max(0.0, event_ms(event) - entered)
            entered = None
    if entered is not None:
        on_screen_ms += max(0.0, end_ms - entered)

    return {
        "watch_seconds": round(watch_ms / 1000.0, 1),
        "on_screen_seconds": round(on_screen_ms / 1000.0, 1),
        "max_playhead_seconds": round(reached_ms / 1000.0, 1),
        "play_spans": len(segments),
    }


def group_by_case(rows: Iterable[Any]) -> dict[tuple[str, int], list[Any]]:
    """Event rows bucketed by (participant_id, video_id), skipping rows with no
    case attached — a login or a progress tick belongs to no clip."""
    buckets: dict[tuple[str, int], list[Any]] = {}
    for row in rows:
        if row.video_id is None:
            continue
        buckets.setdefault((row.participant_id, row.video_id), []).append(row)
    return buckets


def mean(values: Sequence[float]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def median(values: Sequence[float]) -> float | None:
    """The middle value. Reported alongside the mean wherever a single slow
    session would otherwise drag the average somewhere no participant was."""
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return round(ordered[middle], 1)
    return round((ordered[middle - 1] + ordered[middle]) / 2, 1)


def rate(part: float, whole: float) -> float | None:
    """`part` as a percentage of `whole`, or None when there is no whole to be
    a fraction of — which is not the same fact as 0%."""
    return round(part / whole * 100, 1) if whole else None
