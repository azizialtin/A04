"""Raw gaze coordinates and timestamped viewport areas for analysis exports."""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from typing import TYPE_CHECKING, Any, TypeGuard

if TYPE_CHECKING:
    from app.services.display_guard import DisplayGuardIntervals


def finite_number(value: Any) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def averaged_gaze(sample: dict, *, allow_unknown: bool = False) -> tuple[float, float] | None:
    # An eye contributes a coordinate pair, never one axis of an invalid eye.
    eyes = []
    for eye in ("l", "r"):
        x, y = sample.get(f"{eye}x"), sample.get(f"{eye}y")
        validity = sample.get(f"{eye}v")
        valid = validity is True or (allow_unknown and validity is None)
        if valid and finite_number(x) and finite_number(y):
            eyes.append((x, y))
    if not eyes:
        return None
    return sum(x for x, _ in eyes) / len(eyes), sum(y for _, y in eyes) / len(eyes)


def unsupported_mapping_reason(geometry: dict) -> str | None:
    screen, window = geometry.get("screen"), geometry.get("window")
    if (
        not isinstance(screen, dict)
        or not isinstance(window, dict)
        or any(not finite_number(screen.get(key)) for key in ("w", "h"))
        or any(
            not finite_number(window.get(key))
            for key in ("x", "y", "outer_w", "outer_h", "inner_w", "inner_h")
        )
    ):
        return "incomplete_geometry"
    viewport = geometry.get("visual_viewport")
    if viewport is not None and (
        not isinstance(viewport, dict)
        or viewport.get("scale") != 1
        or viewport.get("x") != 0
        or viewport.get("y") != 0
    ):
        return "unsupported_visual_viewport"
    if screen.get("is_extended") is True:
        return "multiple_displays"
    if (
        window["x"] >= screen["w"]
        or window["y"] >= screen["h"]
        or window["x"] + window["outer_w"] <= 0
        or window["y"] + window["outer_h"] <= 0
    ):
        return "window_outside_screen"
    return None


def _display_verified(geometry: dict | None) -> bool:
    guard = geometry.get("display_guard") if geometry else None
    if not (
        isinstance(guard, dict)
        and guard.get("profile") == "lab_1080p"
        and guard.get("verified") is True
        and geometry is not None
        and geometry.get("visible", True) is not False
        and unsupported_mapping_reason(geometry) is None
    ):
        return False
    screen, window = geometry["screen"], geometry["window"]
    dimensions = (
        (screen["w"], 1920),
        (screen["h"], 1080),
        (window["inner_w"], 1920),
        (window["outer_w"], 1920),
        (window["inner_h"], 1080),
        (window["outer_h"], 1080),
        (window["x"], 0),
        (window["y"], 0),
    )
    dpr = geometry.get("dpr")
    return (
        all(abs(actual - expected) <= 1 for actual, expected in dimensions)
        and finite_number(dpr)
        and dpr > 0
        and abs(dpr - 1) <= 0.001
    )


class GazeLayout:
    def __init__(self, geometry: list[dict], interruptions: DisplayGuardIntervals | None = None):
        self.snapshots = sorted(
            (g for g in geometry if finite_number(g.get("ts"))), key=lambda g: g["ts"]
        )
        self.timestamps = [g["ts"] for g in self.snapshots]
        self.guarded = any(g.get("display_guard") is not None for g in self.snapshots)
        self.interruptions = interruptions
        self.by_timestamp: dict[int | float, dict | None] = {}
        for snapshot in self.snapshots:
            ts = snapshot["ts"]
            if ts in self.by_timestamp and self.by_timestamp[ts] != snapshot:
                self.by_timestamp[ts] = None
            else:
                self.by_timestamp[ts] = snapshot

    def geometry_for(self, sample: dict) -> dict | None:
        if not finite_number(sample.get("ts")):
            return None
        if "geometry_ts" in sample:
            reference = sample["geometry_ts"]
            if not finite_number(reference) or reference > sample["ts"]:
                return None
            return self.by_timestamp.get(reference)
        index = bisect_right(self.timestamps, sample["ts"]) - 1
        return self.snapshots[index] if index >= 0 else None

    def display_guard_reason(self, sample: dict) -> str | None:
        if not self.guarded:
            return None
        timestamp = sample.get("ts")
        if not finite_number(timestamp):
            return "unverified_display"
        interval = self.interruptions.at_or_before(timestamp) if self.interruptions else None
        if interval is not None and timestamp < interval[1]:
            return "display_guard_interrupted"
        geometry = self.geometry_for(sample)
        latest_index = bisect_right(self.timestamps, timestamp) - 1
        latest = self.by_timestamp[self.timestamps[latest_index]] if latest_index >= 0 else None
        if (
            not finite_number(sample.get("geometry_ts"))
            or not _display_verified(geometry)
            or not _display_verified(latest)
            or geometry is None
            or geometry != latest
            or (interval is not None and geometry["ts"] < interval[1])
        ):
            return "unverified_display"
        return None

    def suppressed_ranges(self, samples: list[dict]) -> list[tuple[float, float]]:
        """Wall-clock gaps that replay interpolation must not bridge."""
        if not self.guarded:
            return []
        ranges = []
        unverified: float | None = float("-inf")
        verified_timestamps = []
        for timestamp in sorted(self.by_timestamp):
            if _display_verified(self.by_timestamp[timestamp]):
                verified_timestamps.append(timestamp)
                if unverified is not None:
                    ranges.append((unverified, timestamp))
                    unverified = None
            elif unverified is None:
                unverified = timestamp
        if unverified is not None:
            ranges.append((unverified, float("inf")))
        if self.interruptions:
            for start, end in self.interruptions.ranges:
                # A resume revokes the old layout; only a new verified snapshot
                # can end replay suppression after that explicit resume.
                index = bisect_left(verified_timestamps, end)
                verified_at = (
                    verified_timestamps[index] if index < len(verified_timestamps) else float("inf")
                )
                ranges.append((start, verified_at))
        by_timestamp: dict[float, bool] = {}
        for sample in samples:
            sample_ts = sample.get("ts")
            if finite_number(sample_ts):
                by_timestamp[sample_ts] = (
                    by_timestamp.get(sample_ts, False)
                    or self.display_guard_reason(sample) is not None
                )
        timestamps = sorted(by_timestamp)
        for index, timestamp in enumerate(timestamps):
            if by_timestamp[timestamp]:
                end = timestamps[index + 1] if index + 1 < len(timestamps) else float("inf")
                ranges.append((timestamp, end))
        merged: list[tuple[float, float]] = []
        for start, end in sorted(ranges):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        return merged

    def locate(self, sample: dict) -> dict:
        result: dict[str, Any] = {
            "aoi": "invalid",
            "aoi_status": "invalid",
            "mapping_reason": None,
        }
        mean = averaged_gaze(sample)
        if mean is None or not finite_number(sample.get("ts")):
            return result
        x, y = mean
        result.update(screen_x=x, screen_y=y)
        if not (0 <= x <= 1 and 0 <= y <= 1):
            return {**result, "aoi": "offscreen", "aoi_status": "offscreen"}
        result.update(aoi="unmapped", aoi_status="unmapped")
        guard_reason = self.display_guard_reason(sample)
        if guard_reason is not None:
            result["mapping_reason"] = guard_reason
        geometry = self.geometry_for(sample)
        if geometry is None:
            return result
        result.update(layout_ts=geometry["ts"], active_modal=geometry.get("active_modal"))
        try:
            screen, window = geometry["screen"], geometry["window"]
            if screen["w"] <= 0 or screen["h"] <= 0:
                return result
            px, py = x * screen["w"], y * screen["h"]
            vx = px - window["x"] - (window["outer_w"] - window["inner_w"]) / 2
            vy = py - window["y"] - (window["outer_h"] - window["inner_h"])
        except (KeyError, TypeError):
            return result
        result.update(
            screen_px=px,
            screen_py=py,
            viewport_x=vx,
            viewport_y=vy,
            mapping_method="window_estimate",
        )
        if guard_reason is not None:
            return result
        # These signals disprove the simple transform. Keep its candidate
        # coordinates for inspection, but do not assign a research AOI.
        # Missing signals (or is_extended=False) do not verify the transform.
        reason = unsupported_mapping_reason(geometry)
        if reason is not None:
            return {**result, "mapping_reason": reason}
        aois = geometry.get("aois")
        if "geometry_ts" not in sample or geometry.get("visible", True) is False or aois is None:
            return result
        if not (0 <= vx <= window["inner_w"] and 0 <= vy <= window["inner_h"]):
            return {**result, "aoi": "offscreen", "aoi_status": "offscreen"}
        hits = [
            (aoi.get("priority", 0), index, aoi["id"])
            for index, aoi in enumerate(aois)
            if aoi["w"] > 0
            and aoi["h"] > 0
            and aoi["x"] <= vx < aoi["x"] + aoi["w"]
            and aoi["y"] <= vy < aoi["y"] + aoi["h"]
        ]
        return {
            **result,
            "aoi": max(hits)[2] if hits else "other",
            "aoi_status": "matched" if hits else "other",
        }
