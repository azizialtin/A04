"""Turn raw gaze samples into points on a timeline something can play back.

There are two of those, and they are very different amounts of work.

Against a **screen recording** it is a subtraction. The bridge stamps both the
samples and the recording's first frame with the lab machine's wall clock, and
the tracker reports gaze across the whole display — which is exactly what the
recording holds. So the position is `ts - epoch_ms` and the coordinates are
already frame coordinates. Nothing to reconstruct, nothing to undo.

Against the **clip on its own** — the fallback, for a case whose screen capture
failed or predates it — we have to undo pauses and seeks, reconstructed from the
VideoPlayer's playback events (each carries the `currentTime` at the moment it
fired), and then undo the browser chrome and the letterbox to find the picture.

Both sides of that comparison have to come off the same clock, so playback
events are timed by `client_ts` — epoch ms stamped by the browser, which sits on
the same machine as the bridge. The row's `created_at` is a database timestamp
written after a background task and is only a fallback for events recorded
before `client_ts` existed.
"""

from __future__ import annotations

import json
from bisect import bisect_right
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.models.interaction_log import InteractionLog

PLAYBACK_EVENTS = (
    "video_started",
    "video_resumed",
    "video_paused",
    "video_seeked",
    "video_completed",
)

# What goes over the wire. The player interpolates between points and redraws
# at screen rate, so sending every 120 Hz sample is megabytes nobody can see —
# the raw chunks stay on disk as the record.
REPLAY_MIN_GAP_MS = 20
REPLAY_MAX_POINTS = 8000


def read_local_samples(storage_prefix: str | None) -> list[dict[str, Any]]:
    if not storage_prefix:
        return []
    folder = Path(storage_prefix)
    if not folder.is_dir():
        return []
    out: list[dict[str, Any]] = []
    # Chunk names embed the zero-padded running offset, so name order == order.
    for chunk in sorted(folder.glob("chunk_*.ndjson")):
        for line in chunk.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def read_gcs_samples(storage_prefix: str, settings) -> list[dict[str, Any]]:
    from google.cloud import storage

    bucket = storage.Client().bucket(settings.GCP_BUCKET_NAME)
    out: list[dict[str, Any]] = []
    for blob in sorted(bucket.list_blobs(prefix=storage_prefix), key=lambda b: b.name):
        if not blob.name.endswith(".ndjson"):
            continue
        for line in blob.download_as_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def event_ms(ev) -> float:
    """When the event happened, on the browser's clock where we have it."""
    client_ts = getattr(ev, "client_ts", None)
    if isinstance(client_ts, (int, float)):
        return float(client_ts)
    return ev.created_at.timestamp() * 1000.0


def playback_segments(events, end_ms: float | None) -> list[tuple[float, float, float]]:
    """(wall_start_ms, wall_end_ms, video_start_ms) spans during which the clip
    was actually playing. `events` must be ordered by time; each needs
    `.event_type`, `.payload` and either `.client_ts` or `.created_at`.

    A span still open at the end is closed at `end_ms` (the last gaze sample),
    or left open when there is nothing to close it with.
    """
    segments: list[tuple[float, float, float]] = []
    anchor: tuple[float, float] | None = None  # (wall_ms, video_ms)

    def close(end_wall_ms: float) -> None:
        nonlocal anchor
        if anchor is not None and end_wall_ms > anchor[0]:
            segments.append((anchor[0], end_wall_ms, anchor[1]))
        anchor = None

    for ev in events:
        wall_ms = event_ms(ev)
        payload = ev.payload or {}
        try:
            video_ms = float(payload.get("currentTime", 0.0)) * 1000.0
        except (TypeError, ValueError):
            video_ms = 0.0

        if ev.event_type in ("video_started", "video_resumed"):
            close(wall_ms)
            anchor = (wall_ms, video_ms)
        elif ev.event_type == "video_seeked":
            was_playing = anchor is not None
            close(wall_ms)
            # Seeking while playing keeps playing from the new spot; while paused
            # it stays paused until the next resume re-anchors.
            if was_playing:
                anchor = (wall_ms, video_ms)
        elif ev.event_type in ("video_paused", "video_completed"):
            close(wall_ms)

    if anchor is not None:
        close(end_ms if end_ms is not None else float("inf"))
    return segments


def _sample_ts_range(samples: list[dict[str, Any]]) -> tuple[float, float] | None:
    stamps = [s["ts"] for s in samples if isinstance(s.get("ts"), (int, float))]
    return (min(stamps), max(stamps)) if stamps else None


def geometry_at(geometry: list[dict[str, Any]], ts: float) -> dict[str, Any] | None:
    """The geometry in force when a sample at `ts` was taken.

    Samples can arrive a fraction before the first snapshot is posted, so
    anything earlier than the whole list uses the first entry.
    """
    if not geometry:
        return None
    chosen = geometry[0]
    for snap in geometry:
        if snap.get("ts", 0) <= ts:
            chosen = snap
        else:
            break
    return chosen


def to_video_frame(x: float, y: float, geo: dict[str, Any]) -> tuple[float, float] | None:
    """Screen-normalised gaze (0..1 across the whole display, which is what the
    tracker reports) to frame-normalised gaze (0..1 across the picture itself).

    Returns None when the participant was looking somewhere other than the clip
    — at the notes box, the timer, or off the window entirely.

    The viewport's origin on the screen is derived from the window box: browser
    chrome is assumed to sit above the viewport with symmetric side borders.
    That is exact in fullscreen, where outer and inner are the same.
    """
    screen, win, box, frame = geo["screen"], geo["window"], geo["video"], geo["frame"]
    if not (screen["w"] and screen["h"] and box["w"] and box["h"]):
        return None

    viewport_x = win["x"] + (win["outer_w"] - win["inner_w"]) / 2
    viewport_y = win["y"] + (win["outer_h"] - win["inner_h"])

    # Screen pixels, then viewport pixels, then pixels within the video element.
    ex = x * screen["w"] - viewport_x - box["x"]
    ey = y * screen["h"] - viewport_y - box["y"]

    # object-fit: contain letterboxes the picture inside the element box.
    if frame["w"] and frame["h"]:
        scale = min(box["w"] / frame["w"], box["h"] / frame["h"])
        content_w, content_h = frame["w"] * scale, frame["h"] * scale
    else:
        # Metadata had not loaded yet; the best we can do is the element box.
        content_w, content_h = box["w"], box["h"]

    fx = (ex - (box["w"] - content_w) / 2) / content_w
    fy = (ey - (box["h"] - content_h) / 2) / content_h
    if not (0.0 <= fx <= 1.0 and 0.0 <= fy <= 1.0):
        return None
    return fx, fy


def segment_at(
    segments: list[tuple[float, float, float]], starts: list[float], ts: float
) -> tuple[float, float, float] | None:
    """The playing span covering `ts`, found by bisection.

    Scanning the list per sample made this quadratic: a ten-minute clip is
    ~72,000 samples against a segment for every pause and seek.
    """
    i = bisect_right(starts, ts) - 1
    if i < 0:
        return None
    segment = segments[i]
    return segment if ts <= segment[1] else None


def build_points(
    samples: list[dict[str, Any]],
    segments: list[tuple[float, float, float]],
    geometry: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], int, int, int]:
    """Map samples onto video time and onto the picture.

    Returns (points, invalid, unmapped, offscreen). A point is {t, x, y}: t is
    the video position in ms, x/y are 0..1 across the frame.

    Without geometry the coordinates cannot be placed on the video; they are
    passed through as-is so old recordings still render, and the caller tells
    the viewer they are unreliable.
    """
    points: list[dict[str, Any]] = []
    invalid = 0
    unmapped = 0
    offscreen = 0
    ordered = sorted(segments)
    starts = [s[0] for s in ordered]
    for s in samples:
        ts = s.get("ts")
        if not isinstance(ts, (int, float)):
            continue
        seg = segment_at(ordered, starts, ts)
        if seg is None:
            unmapped += 1  # sample taken while paused / not playing
            continue
        mean = _averaged(s)
        if mean is None:
            invalid += 1  # blink / track-loss
            continue

        x, y = mean
        geo = geometry_at(geometry or [], ts)
        if geo is not None:
            mapped = to_video_frame(x, y, geo)
            if mapped is None:
                offscreen += 1  # looking at the rail, the timer, anywhere but the clip
                continue
            x, y = mapped

        points.append({"t": int(seg[2] + (ts - seg[0])), "x": round(x, 4), "y": round(y, 4)})
    points.sort(key=lambda p: p["t"])
    return points, invalid, unmapped, offscreen


def _averaged(sample: dict[str, Any]) -> tuple[float, float] | None:
    """The binocular mean, or None on a blink / track-loss."""
    xs = [v for v in (sample.get("lx"), sample.get("rx")) if isinstance(v, (int, float))]
    ys = [v for v in (sample.get("ly"), sample.get("ry")) if isinstance(v, (int, float))]
    if not xs or not ys:
        return None
    return sum(xs) / len(xs), sum(ys) / len(ys)


def build_screen_points(
    samples: list[dict[str, Any]], epoch_ms: int, duration_ms: int | None = None
) -> tuple[list[dict[str, Any]], int, int, int]:
    """Map samples onto a full-screen recording. Returns the same
    (points, invalid, unmapped, offscreen) shape as `build_points`.

    A sample taken while the clip was paused counts here, where on the clip
    alone it had nowhere to go: the screen was still being recorded, and what
    the participant did with that time is the thing we wanted to see.
    """
    points: list[dict[str, Any]] = []
    invalid = 0
    unmapped = 0
    offscreen = 0
    for sample in samples:
        ts = sample.get("ts")
        if not isinstance(ts, (int, float)):
            continue
        t = ts - epoch_ms
        if t < 0 or (duration_ms and t > duration_ms):
            unmapped += 1  # taken before the capture started, or after it stopped
            continue
        mean = _averaged(sample)
        if mean is None:
            invalid += 1
            continue
        x, y = mean
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            offscreen += 1  # looking past the edge of the display
            continue
        points.append({"t": int(t), "x": round(x, 4), "y": round(y, 4)})
    points.sort(key=lambda p: p["t"])
    return points, invalid, unmapped, offscreen


def downsample(
    points: list[dict[str, Any]],
    min_gap_ms: int = REPLAY_MIN_GAP_MS,
    max_points: int = REPLAY_MAX_POINTS,
) -> list[dict[str, Any]]:
    """Thin a sorted point list down to what a screen can actually show."""
    if not points:
        return points

    thinned = [points[0]]
    for point in points[1:]:
        if point["t"] - thinned[-1]["t"] >= min_gap_ms:
            thinned.append(point)

    if len(thinned) > max_points:
        stride = len(thinned) // max_points + 1
        thinned = thinned[::stride]
    return thinned


async def load_samples(recording, settings) -> list[dict[str, Any]]:
    """Every sample of one recording, off disk or out of the bucket.

    Reading and parsing every chunk is blocking file (or network) work, and this
    runs on the screen a participant is sitting in front of.
    """
    if settings.GAZE_STORAGE_MODE == "gcs" and settings.GCP_BUCKET_NAME:
        return await run_in_threadpool(
            read_gcs_samples,
            recording.storage_prefix or f"gaze/{recording.participant_id}/{recording.id}/",
            settings,
        )
    return await run_in_threadpool(read_local_samples, recording.storage_prefix)


async def compute_screen_replay(recording, screen, settings) -> dict[str, Any]:
    """Replay payload against a screen recording.

    `recording` may be None: the capture is worth playing back on its own, and a
    session where the tracker dropped out is exactly when you want to see what
    the participant was doing.
    """
    samples = await load_samples(recording, settings) if recording is not None else []
    points, invalid, unmapped, offscreen = build_screen_points(
        samples, screen.epoch_ms, screen.duration_ms
    )
    return {
        "points": downsample(points),
        "mapped_samples": len(points),
        "invalid_samples": invalid,
        "unmapped_samples": unmapped,
        "offscreen_samples": offscreen,
        # The recording is the display, so the samples need no geometry to be
        # placed on it — the question the flag answers does not arise here.
        "has_geometry": True,
    }


async def compute_replay(db: AsyncSession, recording, settings) -> dict[str, Any]:
    """Replay payload against the clip alone: read the samples, reconstruct the
    playing spans from the interaction log, and map the samples onto them."""
    samples = await load_samples(recording, settings)

    events = (
        (
            await db.execute(
                select(InteractionLog)
                .where(
                    InteractionLog.participant_id == recording.participant_id,
                    InteractionLog.video_id == recording.video_id,
                    InteractionLog.event_type.in_(PLAYBACK_EVENTS),
                )
                .order_by(InteractionLog.created_at, InteractionLog.id)
            )
        )
        .scalars()
        .all()
    )

    span = _sample_ts_range(samples)
    segments = playback_segments(list(events), span[1] if span else None)
    if not segments and span:
        # No playback events (unusual) — assume it played from 0 the whole time.
        segments = [(span[0], float("inf"), 0.0)]

    geometry = recording.geometry or []
    points, invalid, unmapped, offscreen = build_points(samples, segments, geometry)
    return {
        # What is sent, and what was actually captured on the clip. The stats
        # the researcher reads should be the second, not the render budget.
        "points": downsample(points),
        "mapped_samples": len(points),
        "invalid_samples": invalid,
        "unmapped_samples": unmapped,
        "offscreen_samples": offscreen,
        "has_geometry": bool(geometry),
    }
