"""Raw gaze coordinates and timestamped viewport areas for analysis exports."""

from __future__ import annotations

import math
from bisect import bisect_right
from typing import Any, TypeGuard


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


class GazeLayout:
    def __init__(self, geometry: list[dict]):
        self.snapshots = sorted(
            (g for g in geometry if finite_number(g.get("ts"))), key=lambda g: g["ts"]
        )
        self.timestamps = [g["ts"] for g in self.snapshots]
        self.by_timestamp: dict[int | float, dict | None] = {}
        for snapshot in self.snapshots:
            ts = snapshot["ts"]
            if ts in self.by_timestamp and self.by_timestamp[ts] != snapshot:
                self.by_timestamp[ts] = None
            else:
                self.by_timestamp[ts] = snapshot

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
        if "geometry_ts" in sample:
            reference = sample["geometry_ts"]
            if not finite_number(reference) or reference > sample["ts"]:
                return result
            geometry = self.by_timestamp.get(reference)
            if geometry is None:
                return result
        else:
            i = bisect_right(self.timestamps, sample["ts"]) - 1
            if i < 0:
                return result
            geometry = self.snapshots[i]
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
        # These signals disprove the simple transform. Keep its candidate
        # coordinates for inspection, but do not assign a research AOI.
        # Missing signals (or is_extended=False) do not verify the transform.
        viewport = geometry.get("visual_viewport")
        if viewport is not None and (
            not isinstance(viewport, dict)
            or viewport.get("scale") != 1
            or viewport.get("x") != 0
            or viewport.get("y") != 0
        ):
            return {**result, "mapping_reason": "unsupported_visual_viewport"}
        if screen.get("is_extended") is True:
            return {**result, "mapping_reason": "multiple_displays"}
        if (
            window["x"] >= screen["w"]
            or window["y"] >= screen["h"]
            or window["x"] + window["outer_w"] <= 0
            or window["y"] + window["outer_h"] <= 0
        ):
            return {**result, "mapping_reason": "window_outside_screen"}
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
