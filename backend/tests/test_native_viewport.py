"""Native display-to-CSS mapping: analytical coordinates, persistence and replay."""

import copy
import csv
import io
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.api.gaze import GazeGeometry, GazeSample
from app.models.gaze_recording import GazeRecording
from app.models.screen_recording import ScreenRecording
from app.models.video import Video
from app.services import storage
from app.services.display_guard import display_guard_intervals
from app.services.gaze_analysis import GazeLayout
from app.services.gaze_replay import (
    build_points,
    build_screen_points,
    replay_suppressed_intervals,
    to_video_frame,
)

BASE = 1_700_000_000_000
PROFILE = "native_viewport_v1"
TAB = "1234567890abcdef1234567890abcdef"


def geometry(dpr=1.25, fullscreen=False, physical_width=1440, display_x=0):
    display = {"x": display_x, "y": 0, "w": 1920, "h": 1080}
    content = (
        dict(display)
        if fullscreen
        else {"x": display_x + 148, "y": 96, "w": physical_width, "h": 810}
    )
    # CSS inner dimensions are rounded integers; native content dimensions
    # retain the physical edge. Their ratio is not an exact CSS-pixel scale.
    width = (1920 if fullscreen else 1440) / dpr
    height = (1080 if fullscreen else 810) / dpr
    return {
        "ts": BASE,
        "screen": {"w": 1920, "h": 1080, "is_extended": False},
        "window": {
            "x": display_x + (0 if fullscreen else 140),
            "y": 0 if fullscreen else 30,
            "outer_w": 1920 if fullscreen else 1480,
            "outer_h": 1080 if fullscreen else 920,
            "inner_w": width,
            "inner_h": height,
        },
        "visual_viewport": {"x": 0, "y": 0, "w": width, "h": height, "scale": 1},
        "dpr": dpr,
        "video": {"x": 0, "y": 0, "w": width, "h": height},
        "frame": {"w": 16, "h": 9},
        "aois": [
            {"id": "question", "x": 100, "y": 80, "w": 300, "h": 200},
            {"id": "response", "x": 450, "y": 300, "w": 300, "h": 200},
        ],
        "visible": True,
        "display_guard": {"profile": PROFILE, "verified": True},
        "native_viewport": {
            "id": "viewport-generation-1",
            "tab_id": TAB,
            "display": display,
            "content": content,
            "css": {"w": width, "h": height},
            "dpr": dpr,
        },
    }


def sample(geo, x=250, y=150, offset=100):
    native = geo["native_viewport"]
    display, content = native["display"], native["content"]
    px = content["x"] + x * native["dpr"]
    py = content["y"] + y * native["dpr"]
    return {
        "ts": BASE + offset,
        "device_ts": 1_000_000 + offset * 1000,
        "geometry_ts": geo["ts"],
        "viewport_id": native["id"],
        "viewport_ts": BASE + offset,
        "lx": (px - display["x"]) / display["w"],
        "ly": (py - display["y"]) / display["h"],
        "lv": True,
        "rx": None,
        "ry": None,
        "rv": False,
        "lpd": 3.1,
        "rpd": 3.2,
    }


def event(kind, timestamp, profile=PROFILE):
    return SimpleNamespace(
        event_type=f"display_guard_{kind}", client_ts=timestamp, payload={"profile": profile}
    )


@pytest.mark.parametrize("dpr", [1, 1.25, 1.5, 2])
@pytest.mark.parametrize("fullscreen", [False, True])
@pytest.mark.parametrize("display_x", [0, -1920])
def test_exact_native_bounds_map_gaze_to_css_in_windowed_and_fullscreen(dpr, fullscreen, display_x):
    geo = geometry(dpr, fullscreen, display_x=display_x)
    point = sample(geo)
    result = GazeLayout([geo]).locate(point)
    assert result["aoi"] == "question"
    assert result["aoi_status"] == "matched"
    assert result["mapping_method"] == "native_viewport"
    assert result["mapping_reason"] is None
    assert (result["viewport_x"], result["viewport_y"]) == pytest.approx((250, 150))
    native = geo["native_viewport"]
    assert result["screen_px"] == pytest.approx(display_x + point["lx"] * native["display"]["w"])
    assert to_video_frame(point["lx"], point["ly"], geo) == pytest.approx(
        (250 / native["css"]["w"], 150 / native["css"]["h"])
    )


def test_native_rounding_does_not_stretch_css_coordinates_and_scroll_uses_new_rects():
    geo = geometry(1.25, physical_width=1441)
    result = GazeLayout([geo]).locate(sample(geo, x=250.25, y=150.75))
    assert (result["viewport_x"], result["viewport_y"]) == pytest.approx((250.25, 150.75))
    scrolled = copy.deepcopy(geo)
    scrolled["ts"] = BASE + 200
    scrolled["aois"][0]["y"] = 280
    assert GazeLayout([geo, scrolled]).locate(sample(scrolled, offset=200))["aoi"] == "other"
    assert (
        GazeLayout([geo, scrolled]).locate(sample(scrolled, y=350, offset=200))["aoi"] == "question"
    )


def test_windows_edge_125_percent_zoom_uses_dpr_and_physical_clip_boundary():
    # Actual Windows/Edge evidence: 786 physical pixels, rounded innerWidth 629.
    # The ratio 629/786 stretches CSS coordinates; the measured scale is 1.25.
    geo = geometry(1.25)
    geo["native_viewport"]["content"]["w"] = 786
    geo["native_viewport"]["css"]["w"] = 629
    geo["window"]["inner_w"] = 629
    geo["visual_viewport"]["w"] = 629
    geo["video"]["w"] = 629
    point = sample(geo, x=314.5, y=150.75)
    mapped = GazeLayout([geo]).locate(point)
    assert mapped["aoi"] == "question"
    assert mapped["viewport_x"] == pytest.approx(314.5, abs=1e-9)
    assert mapped["viewport_y"] == pytest.approx(150.75, abs=1e-9)
    # This CSS coordinate is below rounded innerWidth but beyond the actual
    # content edge (786 / 1.25 = 628.8), so it cannot hit the page or video.
    outside = sample(geo, x=628.9, y=150)
    result = GazeLayout([geo]).locate(outside)
    assert result["mapping_reason"] == "outside_viewport"
    assert result["aoi_status"] == "offscreen"
    assert to_video_frame(outside["lx"], outside["ly"], geo) is None


@pytest.mark.parametrize(
    "x,y", [(-10, 150), (250, -10), (1152, 150), (250, 648), (1160, 150), (250, 660)]
)
def test_browser_chrome_and_other_display_space_are_not_research_aois(x, y):
    geo = geometry()
    point = sample(geo, x=x, y=y)
    result = GazeLayout([geo]).locate(point)
    assert result["mapping_method"] == "native_viewport"
    assert result["aoi_status"] == "offscreen"
    assert result["mapping_reason"] == "outside_viewport"
    assert to_video_frame(point["lx"], point["ly"], geo) is None
    # Screen replay still correctly places gaze on the recorded physical screen.
    assert len(build_screen_points([point], BASE, 1000, [geo])[0]) == 1


@pytest.mark.parametrize("delta,accepted", [(-51, False), (-50, True), (50, True), (51, False)])
def test_native_observation_must_be_within_50ms_of_the_sample(delta, accepted):
    geo = geometry()
    point = sample(geo)
    point["viewport_ts"] += delta
    result = GazeLayout([geo]).locate(point)
    assert (result["aoi_status"] == "matched") is accepted
    if not accepted:
        assert result["mapping_reason"] == "stale_native_viewport"


@pytest.mark.parametrize(
    "changed,reason",
    [
        ({"viewport_id": None}, "native_viewport_mismatch"),
        ({"viewport_id": "another-window-generation"}, "native_viewport_mismatch"),
        ({"viewport_ts": None}, "stale_native_viewport"),
        ({"viewport_ts": float("nan")}, "stale_native_viewport"),
        ({"viewport_ts": True}, "stale_native_viewport"),
        ({"geometry_ts": None}, "unverified_display"),
        ({"geometry_ts": BASE + 200}, "unverified_display"),
    ],
)
def test_missing_stale_or_mismatched_proof_never_produces_aoi_or_replay(changed, reason):
    geo = geometry()
    point = {**sample(geo), **changed}
    layout = GazeLayout([geo])
    assert layout.locate(point)["mapping_reason"] == reason
    assert layout.locate(point)["aoi"] == "unmapped"
    assert build_screen_points([point], BASE, 1000, [geo])[0] == []
    assert build_points([point], [(BASE, BASE + 1000, 0)], [geo])[0] == []
    assert replay_suppressed_intervals(layout, [point], [(BASE, BASE + 1000, 0)]) == [
        {"start_ms": 100, "end_ms": 1000}
    ]


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", ""),
        ("tab_id", "not-a-tab"),
        ("dpr", 1),
        ("display", {"x": 0, "y": 0, "w": 100, "h": 100}),
        ("content", {"x": 148, "y": 96, "w": 1300, "h": 810}),
        ("css", {"w": 1151, "h": 648}),
    ],
)
def test_inconsistent_native_geometry_is_never_promoted_to_verified(field, value):
    geo = geometry()
    geo["native_viewport"][field] = value
    assert (
        GazeLayout([geo]).display_guard_reason({**sample(geometry()), "ts": BASE + 100})
        == "unverified_display"
    )


@pytest.mark.parametrize(
    "changed",
    [
        {"visible": False},
        {"dpr": 1.1},
        {"visual_viewport": {"x": 0, "y": 0, "w": 100, "h": 100, "scale": 1.25}},
        {"screen": {"w": 1920, "h": 1080, "is_extended": True}},
    ],
)
def test_hidden_or_contradictory_browser_geometry_remains_excluded(changed):
    geo = {**geometry(), **changed}
    assert GazeLayout([geo]).locate(sample(geometry()))["aoi"] == "unmapped"


def test_delayed_samples_cannot_reuse_old_native_identity_after_window_moves():
    before = geometry()
    after = copy.deepcopy(before)
    after["ts"] = BASE + 200
    after["native_viewport"]["id"] = "viewport-generation-2"
    after["native_viewport"]["content"]["x"] += 40
    layout = GazeLayout([before, after])
    assert layout.locate(sample(before, offset=199))["aoi"] == "question"
    assert layout.locate(sample(before, offset=200))["mapping_reason"] == "unverified_display"
    wrong_identity = {**sample(after, offset=200), "viewport_id": before["native_viewport"]["id"]}
    assert layout.locate(wrong_identity)["mapping_reason"] == "native_viewport_mismatch"
    assert layout.locate(sample(after, offset=200))["aoi"] == "question"
    ambiguous = {**after, "aois": []}
    assert (
        GazeLayout([before, after, ambiguous]).locate(sample(after, offset=200))["aoi"]
        == "unmapped"
    )


def test_profiles_isolate_legacy_open_interruption_from_native_and_native_from_legacy():
    native = geometry()
    legacy = geometry(1, True)
    legacy.pop("native_viewport")
    legacy["display_guard"]["profile"] = "lab_1080p"
    legacy["window"]["x"] = 0
    legacy["window"]["y"] = 0
    p = sample(geometry(1, True))
    legacy_events = display_guard_intervals([event("interrupted", BASE, "lab_1080p")])
    native_events = display_guard_intervals([event("interrupted", BASE)])
    assert GazeLayout([native], legacy_events).locate(sample(native))["aoi"] == "question"
    assert GazeLayout([legacy], native_events).locate(p)["aoi"] == "question"
    assert (
        GazeLayout([native], native_events).locate(sample(native))["mapping_reason"]
        == "display_guard_interrupted"
    )
    assert (
        GazeLayout([legacy], legacy_events).locate(p)["mapping_reason"]
        == "display_guard_interrupted"
    )
    assert GazeLayout([native], legacy_events).suppressed_ranges([sample(native)]) == [
        (float("-inf"), BASE)
    ]
    assert GazeLayout([legacy], native_events).suppressed_ranges([p]) == [(float("-inf"), BASE)]


def test_mixed_profile_replay_intervals_do_not_extend_across_the_profile_boundary():
    native = geometry()
    native["ts"] = BASE + 200
    legacy = geometry(1, True)
    legacy.pop("native_viewport")
    legacy["display_guard"]["profile"] = "lab_1080p"
    intervals = display_guard_intervals(
        [
            event("interrupted", BASE + 50, "lab_1080p"),
            event("interrupted", BASE + 300),
            event("resumed", BASE + 400),
        ]
    )
    resumed = {**native, "ts": BASE + 400}
    layout = GazeLayout([legacy, native, resumed], intervals)
    assert replay_suppressed_intervals(layout, [], [(BASE, BASE + 1000, 0)]) == [
        {"start_ms": 50, "end_ms": 200},
        {"start_ms": 300, "end_ms": 400},
    ]
    assert layout.locate(sample(native, offset=200))["aoi"] == "question"
    assert (
        layout.locate(sample(native, offset=350))["mapping_reason"] == "display_guard_interrupted"
    )
    assert layout.locate(sample(native, offset=450))["mapping_reason"] == "unverified_display"
    assert layout.locate(sample(resumed, offset=450))["aoi"] == "question"


def test_native_clip_mapping_retains_letterboxing_and_does_not_map_a_clipped_video_on_chrome():
    geo = geometry()
    geo["video"] = {"x": 100, "y": 100, "w": 400, "h": 400}
    point = sample(geo, x=300, y=300)
    assert to_video_frame(point["lx"], point["ly"], geo) == pytest.approx((0.5, 0.5))
    bar = sample(geo, x=300, y=110)
    assert to_video_frame(bar["lx"], bar["ly"], geo) is None
    geo["video"] = {"x": 0, "y": -300, "w": 1152, "h": 648}
    chrome = sample(geo, x=300, y=-20)
    assert to_video_frame(chrome["lx"], chrome["ly"], geo) is None


def test_native_schema_preserves_proof_and_omits_absent_fields_for_historical_retries():
    geo = geometry()
    assert GazeGeometry.model_validate(geo).snapshot()["native_viewport"] == geo["native_viewport"]
    old = {
        key: value for key, value in geo.items() if key not in ("native_viewport", "display_guard")
    }
    historical = GazeGeometry.model_validate(old).snapshot()
    assert "native_viewport" not in historical and "display_guard" not in historical
    old_sample = {
        key: value for key, value in sample(geo).items() if not key.startswith("viewport_")
    }
    assert GazeSample.model_validate(old_sample).model_dump(exclude_unset=True) == old_sample
    for invalid in ("", "x" * 129):
        with pytest.raises(ValidationError):
            GazeSample.model_validate({**sample(geo), "viewport_id": invalid})
    with pytest.raises(ValidationError):
        GazeSample.model_validate({**sample(geo), "viewport_ts": float("nan")})
    with pytest.raises(ValidationError):
        GazeSample.model_validate({**sample(geo), "viewport_ts": True})
    with pytest.raises(ValidationError):
        GazeGeometry.model_validate(
            {**geo, "native_viewport": {**geo["native_viewport"], "dpr": True}}
        )


@pytest.mark.parametrize("replay_source", ["clip", "screen"])
async def test_native_proof_survives_api_retry_csv_and_both_replay_apis(
    client,
    db,
    seed_study,
    seed_participant,
    participant_headers,
    admin_headers,
    tmp_path,
    monkeypatch,
    replay_source,
):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    video = Video(
        study_id=seed_study.id,
        title="Native mapping",
        phase_type="training",
        gcp_filename="native.mp4",
    )
    db.add(video)
    await db.flush()
    geo = geometry()
    started = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={"video_id": video.id, "sampling_rate_hz": 120, "geometry": geo},
    )
    assert started.status_code == 201, started.text
    recording_id = started.json()["recording_id"]
    samples = [sample(geo, offset=100 + index * 10) for index in range(10)]
    samples.append({**sample(geo, offset=200), "viewport_id": "old-generation"})
    for _ in range(2):
        response = await client.post(
            f"/gaze/recordings/{recording_id}/samples",
            headers=participant_headers,
            json={"offset": 0, "samples": samples},
        )
        assert response.status_code == 200, response.text
    assert response.json()["duplicate"] is True
    complete = await client.patch(
        f"/gaze/recordings/{recording_id}/complete",
        headers=participant_headers,
        json={"sample_count": len(samples)},
    )
    assert complete.status_code == 200
    rec = await db.get(GazeRecording, recording_id)
    assert rec.sample_count == len(samples)
    assert rec.geometry[0]["native_viewport"] == geo["native_viewport"]
    if replay_source == "screen":
        db.add(
            ScreenRecording(
                participant_id=seed_participant.id,
                video_id=video.id,
                status="stored",
                storage_path="native.mp4",
                epoch_ms=BASE,
                duration_ms=1000,
            )
        )
        await db.flush()
    # The pilot may have had an old guard interruption before installing this client.
    response = await client.post(
        "/participant/events",
        headers=participant_headers,
        json={
            "event_type": "display_guard_interrupted",
            "client_ts": BASE - 100,
            "payload": {"profile": "lab_1080p"},
        },
    )
    assert response.status_code == 202
    response = await client.get(
        f"/admin/studies/{seed_study.id}/export/gaze", headers=admin_headers
    )
    assert response.status_code == 200
    rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert len(rows) == len(samples)
    assert [row["aoi"] for row in rows] == ["question"] * 10 + ["unmapped"]
    assert rows[-1]["mapping_reason"] == "native_viewport_mismatch"
    for row, point in zip(rows, samples, strict=True):
        assert row["mapping_method"] == "native_viewport"
        assert row["viewport_id"] == point["viewport_id"]
        assert float(row["viewport_ts"]) == point["viewport_ts"]
        assert float(row["viewport_x"]) == pytest.approx(250)
        assert float(row["lpd"]) == 3.1
    for url, headers in [
        (f"/gaze/videos/{video.id}/replay", participant_headers),
        (f"/admin/gaze/recordings/{recording_id}/replay", admin_headers),
    ]:
        response = await client.get(url, headers=headers)
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["source"] == replay_source
        assert payload["plotted_points"] == 10
        assert payload["unmapped_samples"] == 1
        assert payload["points"]
        if replay_source == "clip":
            assert payload["points"][0]["x"] == pytest.approx(round(250 / 1152, 4))
        else:
            assert payload["points"][0]["x"] == pytest.approx(round(samples[0]["lx"], 4))
