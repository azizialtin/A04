"""Raw gaze coordinates and timestamped viewport areas for analysis exports."""

from __future__ import annotations

import math
import re
from bisect import bisect_left, bisect_right
from collections import defaultdict
from typing import TYPE_CHECKING, Any, TypeGuard

if TYPE_CHECKING:
    from app.services.display_guard import DisplayGuardIntervals


def finite_number(value: Any) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


NATIVE_VIEWPORT_PROFILE = "native_viewport_v1"
NATIVE_SAMPLE_MAX_AGE_MS = 50


def guard_profile(geometry: dict | None) -> str | None:
    guard = geometry.get("display_guard") if geometry else None
    profile = guard.get("profile") if isinstance(guard, dict) else None
    return profile if isinstance(profile, str) else None


def native_mapping_reason(geometry: dict) -> str | None:
    """Validate native physical/CSS pairing without inferring any browser chrome."""
    native = geometry.get("native_viewport")
    window = geometry.get("window")
    if (
        guard_profile(geometry) != NATIVE_VIEWPORT_PROFILE
        or not isinstance(native, dict)
        or not isinstance(window, dict)
        or not isinstance(native.get("id"), str)
        or not 1 <= len(native["id"]) <= 128
        or not isinstance(native.get("tab_id"), str)
        or re.fullmatch(r"[0-9a-fA-F]{32}", native["tab_id"]) is None
    ):
        return "invalid_native_viewport"
    for key, fields in (
        ("display", ("x", "y", "w", "h")),
        ("content", ("x", "y", "w", "h")),
        ("css", ("w", "h")),
    ):
        value = native.get(key)
        if (
            not isinstance(value, dict)
            or any(not finite_number(value.get(field)) for field in fields)
            or value["w"] <= 0
            or value["h"] <= 0
        ):
            return "invalid_native_viewport"
    display, content, css = native["display"], native["content"], native["css"]
    dpr = native.get("dpr")
    if (
        not finite_number(dpr)
        or dpr <= 0
        or not finite_number(geometry.get("dpr"))
        or abs(geometry["dpr"] - dpr) > 0.001
        or not finite_number(window.get("inner_w"))
        or not finite_number(window.get("inner_h"))
        or abs(css["w"] - window["inner_w"]) > 0.001
        or abs(css["h"] - window["inner_h"]) > 0.001
        or abs(content["w"] - css["w"] * dpr) > 2
        or abs(content["h"] - css["h"] * dpr) > 2
        or content["x"] < display["x"]
        or content["y"] < display["y"]
        or content["x"] + content["w"] > display["x"] + display["w"]
        or content["y"] + content["h"] > display["y"] + display["h"]
    ):
        return "invalid_native_viewport"
    return None


def screen_to_viewport(
    x: float, y: float, geometry: dict
) -> tuple[float, float, float, float, str] | None:
    """Display-normalised gaze to screen pixels and viewport CSS pixels.

    Native pixels are desktop physical pixels. Historical screen pixels retain
    their original browser-reported units and estimated chrome transform.
    """
    if (
        geometry.get("native_viewport") is not None
        or guard_profile(geometry) == NATIVE_VIEWPORT_PROFILE
    ):
        if native_mapping_reason(geometry) is not None:
            return None
        native = geometry["native_viewport"]
        display, content = native["display"], native["content"]
        px, py = display["x"] + x * display["w"], display["y"] + y * display["h"]
        return (
            px,
            py,
            # innerWidth/innerHeight round CSS pixels. Stretching the physical
            # bounds to those rounded integers introduces a scale error at zoom.
            (px - content["x"]) / native["dpr"],
            (py - content["y"]) / native["dpr"],
            "native_viewport",
        )
    try:
        screen, window = geometry["screen"], geometry["window"]
        if screen["w"] <= 0 or screen["h"] <= 0:
            return None
        px, py = x * screen["w"], y * screen["h"]
        return (
            px,
            py,
            px - window["x"] - (window["outer_w"] - window["inner_w"]) / 2,
            py - window["y"] - (window["outer_h"] - window["inner_h"]),
            "window_estimate",
        )
    except (KeyError, TypeError):
        return None


def native_viewport_contains(px: float, py: float, geometry: dict) -> bool:
    """Use native physical edges, not the rounded CSS innerWidth/innerHeight."""
    content = geometry["native_viewport"]["content"]
    return (
        content["x"] <= px < content["x"] + content["w"]
        and content["y"] <= py < content["y"] + content["h"]
    )


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
        geometry.get("native_viewport") is not None
        or guard_profile(geometry) == NATIVE_VIEWPORT_PROFILE
    ):
        return native_mapping_reason(geometry)
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
        and guard.get("profile") in ("lab_1080p", NATIVE_VIEWPORT_PROFILE)
        and guard.get("verified") is True
        and geometry is not None
        and geometry.get("visible", True) is not False
        and unsupported_mapping_reason(geometry) is None
    ):
        return False
    if guard.get("profile") == NATIVE_VIEWPORT_PROFILE:
        return True
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
        self.guarded = any(
            g.get("display_guard") is not None or g.get("native_viewport") is not None
            for g in self.snapshots
        )
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
        geometry = self.geometry_for(sample)
        latest_index = bisect_right(self.timestamps, timestamp) - 1
        latest = self.by_timestamp[self.timestamps[latest_index]] if latest_index >= 0 else None
        profile = guard_profile(geometry) or guard_profile(latest)
        intervals = self.interruptions.for_profile(profile or "") if self.interruptions else None
        interval = intervals.at_or_before(timestamp) if intervals else None
        if interval is not None and timestamp < interval[1]:
            return "display_guard_interrupted"
        if (
            not finite_number(sample.get("geometry_ts"))
            or not _display_verified(geometry)
            or not _display_verified(latest)
            or geometry is None
            or geometry != latest
            or (interval is not None and geometry["ts"] < interval[1])
        ):
            return "unverified_display"
        if profile == NATIVE_VIEWPORT_PROFILE:
            if sample.get("viewport_id") != geometry["native_viewport"]["id"]:
                return "native_viewport_mismatch"
            observed = sample.get("viewport_ts")
            if not finite_number(observed) or abs(observed - timestamp) > NATIVE_SAMPLE_MAX_AGE_MS:
                return "stale_native_viewport"
        return None

    def suppressed_ranges(self, samples: list[dict]) -> list[tuple[float, float]]:
        """Wall-clock gaps that replay interpolation must not bridge."""
        if not self.guarded:
            return []
        ranges = []
        unverified: float | None = float("-inf")
        verified_timestamps: dict[str, list[float]] = defaultdict(list)
        profile_spans: list[tuple[float, float, str | None]] = []
        timestamps = sorted(self.by_timestamp)
        for index, timestamp in enumerate(timestamps):
            snapshot = self.by_timestamp[timestamp]
            profile = guard_profile(snapshot)
            end = timestamps[index + 1] if index + 1 < len(timestamps) else float("inf")
            if profile_spans and profile_spans[-1][2] == profile:
                profile_spans[-1] = (profile_spans[-1][0], end, profile)
            else:
                profile_spans.append((timestamp, end, profile))
            if _display_verified(snapshot):
                assert profile is not None
                verified_timestamps[profile].append(timestamp)
                if unverified is not None:
                    ranges.append((unverified, timestamp))
                    unverified = None
            elif unverified is None:
                unverified = timestamp
        if unverified is not None:
            ranges.append((unverified, float("inf")))
        if self.interruptions:
            for span_start, span_end, profile in profile_spans:
                if profile is None:
                    continue
                verified = verified_timestamps[profile]
                for start, end in self.interruptions.for_profile(profile).ranges:
                    # A resume revokes the old layout. Only a new verified
                    # snapshot for this profile can end its replay suppression.
                    index = bisect_left(verified, end)
                    verified_at = verified[index] if index < len(verified) else float("inf")
                    lower, upper = max(start, span_start), min(verified_at, span_end)
                    if lower < upper:
                        ranges.append((lower, upper))
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
        coordinates = screen_to_viewport(x, y, geometry)
        if coordinates is None:
            return result
        px, py, vx, vy, method = coordinates
        window = geometry["window"]
        result.update(
            screen_px=px,
            screen_py=py,
            viewport_x=vx,
            viewport_y=vy,
            mapping_method=method,
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
        inside_viewport = (
            native_viewport_contains(px, py, geometry)
            if method == "native_viewport"
            else 0 <= vx <= window["inner_w"] and 0 <= vy <= window["inner_h"]
        )
        if not inside_viewport:
            return {
                **result,
                "aoi": "offscreen",
                "aoi_status": "offscreen",
                **({"mapping_reason": "outside_viewport"} if method == "native_viewport" else {}),
            }
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
