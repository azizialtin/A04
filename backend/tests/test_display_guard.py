import copy
import csv
import io
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.api.gaze import GazeGeometry
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire
from app.models.screen_recording import ScreenRecording
from app.models.video import Video
from app.services import storage
from app.services.display_guard import display_guard_intervals
from app.services.gaze_analysis import GazeLayout
from app.services.gaze_replay import (
    build_points,
    build_screen_points,
    replay_suppressed_intervals,
)

BASE = 1_700_000_000_000
GEOMETRY = {
    "ts": BASE,
    "screen": {"w": 1920, "h": 1080},
    "dpr": 1,
    "window": {"x": 0, "y": 0, "outer_w": 1920, "outer_h": 1080, "inner_w": 1920, "inner_h": 1080},
    "video": {"x": 0, "y": 0, "w": 1920, "h": 1080},
    "frame": {"w": 1920, "h": 1080},
    "aois": [{"id": "video", "x": 0, "y": 0, "w": 1920, "h": 1080}],
    "display_guard": {"profile": "lab_1080p", "verified": True},
}


def sample(offset, reference=BASE):
    return {
        "ts": BASE + offset,
        "geometry_ts": reference,
        "lx": 0.5,
        "ly": 0.5,
        "lv": True,
        "rx": 0.6,
        "ry": 0.4,
        "rv": False,
        "lpd": 3.1,
        "rpd": 3.2,
    }


def event(kind, timestamp, profile="lab_1080p"):
    return SimpleNamespace(
        event_type=f"display_guard_{kind}", client_ts=timestamp, payload={"profile": profile}
    )


def test_interval_union_uses_client_clock_and_interruption_wins_ties():
    events = [
        event("resumed", 50),
        event("resumed", 30),
        event("interrupted", 20),
        event("interrupted", 10),
        event("interrupted", 10),
        event("resumed", 0),
        event("interrupted", 30),
        event("resumed", 90),
        event("interrupted", 90),
    ]
    intervals = display_guard_intervals(events)
    assert intervals.ranges == ((10, 50), (90, float("inf")))
    assert [intervals.interrupted(ts) for ts in (9, 10, 30, 49, 50, 89, 90, 1000)] == [
        False,
        True,
        True,
        True,
        False,
        False,
        True,
        True,
    ]
    assert display_guard_intervals(reversed(events)) == intervals


def test_intervals_ignore_missing_clock_unknown_events_and_other_profiles():
    events = [event("interrupted", value) for value in (None, True, float("nan"), "10")]
    events.extend([event("interrupted", 10, "other"), event("unknown", 10)])
    events.append(SimpleNamespace(event_type="display_guard_interrupted", client_ts=10, payload=[]))
    assert display_guard_intervals(events).ranges == ()


@pytest.mark.parametrize("reference", [None, BASE - 1, BASE + 1001, "bad"])
def test_guarded_missing_unknown_and_future_references_are_unverified(reference):
    result = GazeLayout([GEOMETRY]).locate(sample(1000, reference))
    assert result["aoi"] == result["aoi_status"] == "unmapped"
    assert result["mapping_reason"] == "unverified_display"
    assert result["screen_x"] == 0.5


@pytest.mark.parametrize(
    "guard",
    [None, {}, {"profile": "other", "verified": True}, {"profile": "lab_1080p", "verified": False}],
)
def test_guarded_recording_requires_verified_snapshot_for_each_sample(guard):
    later = {**GEOMETRY, "ts": BASE + 1000, "display_guard": guard}
    result = GazeLayout([GEOMETRY, later]).locate(sample(1000, BASE + 1000))
    assert result["mapping_reason"] == "unverified_display"
    assert result["aoi"] == "unmapped"
    assert result["viewport_x"] == 960


def test_ambiguous_missing_reference_and_no_timestamp_do_not_certify_guarded_display():
    layout = GazeLayout([GEOMETRY, {**GEOMETRY, "aois": []}])
    assert layout.locate(sample(0))["mapping_reason"] == "unverified_display"
    missing_reference = sample(0)
    del missing_reference["geometry_ts"]
    assert (
        GazeLayout([GEOMETRY]).locate(missing_reference)["mapping_reason"] == "unverified_display"
    )
    assert GazeLayout([GEOMETRY]).display_guard_reason({}) == "unverified_display"


def test_resume_needs_fresh_verified_geometry_and_boundaries_are_conservative():
    intervals = display_guard_intervals(
        [event("resumed", BASE + 300), event("interrupted", BASE + 100)]
    )
    geometries = [GEOMETRY, {**GEOMETRY, "ts": BASE + 300}]
    layout = GazeLayout(geometries, intervals)
    assert layout.locate(sample(99))["aoi"] == "video"
    for offset in (100, 200, 299):
        assert layout.locate(sample(offset))["mapping_reason"] == "display_guard_interrupted"
    assert layout.locate(sample(300))["mapping_reason"] == "unverified_display"
    assert layout.locate(sample(300, BASE + 300))["aoi"] == "video"
    assert layout.locate(sample(301, BASE + 300))["aoi"] == "video"


def test_unverified_geometry_revokes_old_reference_even_without_event_delivery():
    geometries = [
        GEOMETRY,
        {
            **GEOMETRY,
            "ts": BASE + 100,
            "display_guard": {"profile": "lab_1080p", "verified": False},
        },
        {**GEOMETRY, "ts": BASE + 300},
    ]
    layout = GazeLayout(geometries)
    for offset in (100, 200, 300):
        assert layout.locate(sample(offset))["mapping_reason"] == "unverified_display"
    assert layout.locate(sample(300, BASE + 300))["aoi"] == "video"
    assert replay_suppressed_intervals(layout, [], [(BASE, BASE + 1000, 0)]) == [
        {"start_ms": 100, "end_ms": 300}
    ]


@pytest.mark.parametrize(
    "changed", [{"visible": False}, {"screen": {"w": 1920, "h": 1080, "is_extended": True}}]
)
def test_guard_does_not_certify_contradictory_geometry(changed):
    layout = GazeLayout([{**GEOMETRY, **changed}])
    assert layout.locate(sample(0))["mapping_reason"] == "unverified_display"
    assert build_screen_points([sample(0)], BASE, 1000, [{**GEOMETRY, **changed}])[0] == []


@pytest.mark.parametrize(
    ("group", "key", "value"),
    [
        ("screen", "w", 1918),
        ("screen", "h", 1078),
        ("window", "inner_w", 1918),
        ("window", "outer_w", 1918),
        ("window", "inner_h", 1078),
        ("window", "outer_h", 1078),
        ("window", "x", 2),
        ("window", "y", -2),
        (None, "dpr", 1.25),
        (None, "dpr", 1.0011),
        (None, "dpr", 0.9989),
        (None, "dpr", 0),
        (None, "dpr", -1),
        (None, "dpr", None),
        (None, "dpr", float("inf")),
        (None, "dpr", float("nan")),
        (None, "dpr", True),
    ],
)
def test_verified_flag_cannot_certify_geometry_outside_lab_profile(group, key, value):
    geometry = copy.deepcopy(GEOMETRY)
    (geometry[group] if group else geometry)[key] = value
    layout = GazeLayout([geometry])
    result = layout.locate(sample(0))
    assert result["aoi"] == result["aoi_status"] == "unmapped"
    assert result["mapping_reason"] == "unverified_display"
    assert build_screen_points([sample(0)], BASE, 1000, [geometry])[0] == []
    assert build_points([sample(0)], [(BASE, BASE + 1000, 0)], [geometry])[0] == []
    assert replay_suppressed_intervals(layout, [sample(0)], [(BASE, BASE + 1000, 0)]) == [
        {"start_ms": 0, "end_ms": 1000}
    ]


def test_guarded_missing_scale_is_unverified_but_api_snapshot_supplies_default():
    geometry = {key: value for key, value in GEOMETRY.items() if key != "dpr"}
    assert GazeLayout([geometry]).locate(sample(0))["mapping_reason"] == "unverified_display"
    snapshot = GazeGeometry.model_validate(geometry).snapshot()
    assert snapshot["dpr"] == 1
    assert GazeLayout([snapshot]).locate(sample(0))["aoi"] == "video"


@pytest.mark.parametrize("offset", [-1, 1])
def test_guarded_profile_allows_the_same_small_metric_tolerances_as_frontend(offset):
    geometry = copy.deepcopy(GEOMETRY)
    geometry["screen"] = {"w": 1920 + offset, "h": 1080 + offset}
    geometry["window"] = {key: value + offset for key, value in geometry["window"].items()}
    geometry["dpr"] = 1 + offset * 0.0009
    assert GazeLayout([geometry]).locate(sample(0))["aoi"] == "video"
    assert len(build_screen_points([sample(0)], BASE, 1000, [geometry])[0]) == 1


def test_non_lab_historical_geometry_remains_mappable_without_guard_metadata():
    geometry = {
        "ts": BASE,
        "screen": {"w": 1536, "h": 864},
        "window": {
            "x": 10,
            "y": 20,
            "outer_w": 1200,
            "outer_h": 800,
            "inner_w": 1200,
            "inner_h": 800,
        },
        "dpr": 1.25,
        "video": {"x": 0, "y": 0, "w": 1200, "h": 800},
        "aois": [{"id": "video", "x": 0, "y": 0, "w": 1200, "h": 800}],
    }
    assert GazeLayout([geometry]).locate(sample(0))["aoi"] == "video"
    assert len(build_screen_points([sample(0)], BASE, 1000, [geometry])[0]) == 1
    assert len(build_points([sample(0)], [(BASE, BASE + 1000, 0)], [geometry])[0]) == 1


def test_short_interruption_without_samples_still_suppresses_replay_interpolation():
    intervals = display_guard_intervals(
        [event("interrupted", BASE + 100), event("resumed", BASE + 150)]
    )
    layout = GazeLayout([GEOMETRY, {**GEOMETRY, "ts": BASE + 150}], intervals)
    samples = [sample(0), sample(200, BASE + 150)]
    assert replay_suppressed_intervals(layout, samples, [(BASE, BASE + 1000, 0)]) == [
        {"start_ms": 100, "end_ms": 150}
    ]


def test_resume_without_new_geometry_suppresses_until_new_verified_snapshot():
    intervals = display_guard_intervals(
        [event("interrupted", BASE + 100), event("resumed", BASE + 200)]
    )
    for geometry, expected_end in [
        ([GEOMETRY], None),
        ([GEOMETRY, {**GEOMETRY, "ts": BASE + 400}], 400),
    ]:
        assert replay_suppressed_intervals(
            GazeLayout(geometry, intervals), [], [(BASE, float("inf"), 0)]
        ) == [{"start_ms": 100, "end_ms": expected_end}]


def test_null_reference_gaps_and_duplicate_clock_samples_remain_suppressed():
    samples = [sample(0), sample(100), sample(100, None), sample(200), sample(300, None)]
    assert replay_suppressed_intervals(
        GazeLayout([GEOMETRY]), samples, [(BASE, float("inf"), 0)]
    ) == [{"start_ms": 100, "end_ms": 200}, {"start_ms": 300, "end_ms": None}]


def test_suppression_uses_capture_epoch_and_clip_seek_timeline():
    intervals = display_guard_intervals(
        [event("interrupted", BASE + 450), event("resumed", BASE + 550)]
    )
    layout = GazeLayout([GEOMETRY, {**GEOMETRY, "ts": BASE + 550}], intervals)
    assert replay_suppressed_intervals(
        layout, [], [(BASE, BASE + 300, 0), (BASE + 400, BASE + 700, 100)]
    ) == [{"start_ms": 150, "end_ms": 250}]
    assert replay_suppressed_intervals(layout, [], [(BASE + 100, BASE + 1000, 0)]) == [
        {"start_ms": 350, "end_ms": 450}
    ]


def test_guarded_capture_before_first_verified_layout_is_suppressed_and_legacy_is_not():
    assert replay_suppressed_intervals(
        GazeLayout([GEOMETRY]), [], [(BASE - 100, BASE + 1000, 0)]
    ) == [{"start_ms": 0, "end_ms": 100}]
    legacy = {key: value for key, value in GEOMETRY.items() if key != "display_guard"}
    assert (
        replay_suppressed_intervals(
            GazeLayout([legacy]), [sample(100, None)], [(BASE - 100, BASE + 1000, 0)]
        )
        == []
    )


@pytest.mark.parametrize("screen", [False, True])
def test_both_replay_builders_suppress_guarded_intervals_and_unverified_layouts(screen):
    intervals = display_guard_intervals(
        [event("interrupted", BASE + 100), event("resumed", BASE + 300)]
    )
    geometries = [GEOMETRY, {**GEOMETRY, "ts": BASE + 300}]
    samples = [sample(0), sample(100), sample(200, None), sample(300), sample(400, BASE + 300)]
    if screen:
        points, invalid, unmapped, offscreen = build_screen_points(
            samples, BASE, 1000, geometries, intervals
        )
    else:
        points, invalid, unmapped, offscreen = build_points(
            samples, [(BASE, BASE + 1000, 0)], geometries, intervals
        )
    assert [point["t"] for point in points] == [0, 400]
    assert (invalid, unmapped, offscreen) == (0, 3, 0)


def test_historical_screen_and_clip_replay_do_not_gain_guard_requirements():
    legacy = {key: value for key, value in GEOMETRY.items() if key != "display_guard"}
    intervals = display_guard_intervals([event("interrupted", BASE)])
    assert GazeLayout([legacy], intervals).locate(sample(0))["aoi"] == "video"
    assert (
        GazeLayout([{**legacy, "display_guard": None}], intervals).locate(sample(0))["aoi"]
        == "video"
    )
    missing_reference = sample(100, None)
    assert build_screen_points([missing_reference], BASE, 1000, [legacy], intervals)[0] == [
        {"t": 100, "x": 0.5, "y": 0.5}
    ]
    historical = {key: value for key, value in sample(100).items() if key != "geometry_ts"}
    assert build_points([historical], [(BASE, BASE + 1000, 0)], None, intervals)[0] == [
        {"t": 100, "x": 0.5, "y": 0.5}
    ]


@pytest.mark.parametrize("guard", [{}, {"display_guard": None}])
def test_absent_guard_keeps_legacy_serialized_snapshot_shape(guard):
    old = {key: value for key, value in GEOMETRY.items() if key != "display_guard"}
    snapshot = GazeGeometry.model_validate({**old, **guard}).snapshot()
    assert "display_guard" not in snapshot
    assert GazeLayout([snapshot, dict(snapshot)]).locate(sample(0))["aoi"] == "video"


@pytest.mark.parametrize(
    "guard",
    [
        {"profile": "wrong", "verified": True},
        {"profile": "lab_1080p", "verified": "true"},
        {"profile": "lab_1080p"},
    ],
)
async def test_geometry_rejects_malformed_guard(client, participant_headers, guard):
    response = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={
            "step_kind": "questionnaire",
            "sampling_rate_hz": 120,
            "geometry": {**GEOMETRY, "display_guard": guard},
        },
    )
    assert response.status_code == 422
    assert any("display_guard" in error["loc"] for error in response.json()["detail"])


@pytest.mark.parametrize("source", ["clip", "screen"])
async def test_late_durable_events_reclassify_uploaded_gaze_and_both_replay_apis(
    client,
    db,
    seed_study,
    seed_participant,
    participant_headers,
    admin_headers,
    tmp_path,
    monkeypatch,
    source,
):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    video = Video(
        study_id=seed_study.id, title="Guarded lab", phase_type="training", gcp_filename="guard.mp4"
    )
    db.add(video)
    await db.flush()
    response = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={"video_id": video.id, "sampling_rate_hz": 120, "geometry": GEOMETRY},
    )
    assert response.status_code == 201
    recording_id = response.json()["recording_id"]
    geometry = {**GEOMETRY, "ts": BASE + 400}
    assert (
        await client.post(
            f"/gaze/recordings/{recording_id}/geometry", headers=participant_headers, json=geometry
        )
    ).status_code == 202
    samples = [
        sample(0),
        sample(100),
        sample(200),
        sample(300),
        sample(400, BASE + 400),
        sample(500, None),
    ]
    assert (
        await client.post(
            f"/gaze/recordings/{recording_id}/samples",
            headers=participant_headers,
            json={"offset": 0, "samples": samples},
        )
    ).status_code == 200
    assert (
        await client.patch(
            f"/gaze/recordings/{recording_id}/complete",
            headers=participant_headers,
            json={"sample_count": len(samples)},
        )
    ).status_code == 200
    if source == "screen":
        db.add(
            ScreenRecording(
                participant_id=seed_participant.id,
                video_id=video.id,
                status="stored",
                storage_path="guard.mp4",
                epoch_ms=BASE,
                duration_ms=1000,
            )
        )
        await db.flush()

    async def export_rows():
        response = await client.get(
            f"/admin/studies/{seed_study.id}/export/gaze", headers=admin_headers
        )
        assert response.status_code == 200
        return list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))

    async def assert_replay(expected, suppressed):
        for url, headers in [
            (f"/gaze/videos/{video.id}/replay", participant_headers),
            (f"/admin/gaze/recordings/{recording_id}/replay", admin_headers),
        ]:
            response = await client.get(url, headers=headers)
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["source"] == source
            assert body["plotted_points"] == len(expected)
            assert [point["t"] for point in body["points"]] == expected
            assert body["unmapped_samples"] == len(samples) - len(expected)
            assert body["suppressed_intervals"] == suppressed

    ending = 1000 if source == "screen" else None
    await assert_replay([0, 100, 200, 300, 400], [{"start_ms": 500, "end_ms": ending}])
    before = await export_rows()
    assert [row["aoi"] for row in before] == ["video"] * 5 + ["unmapped"]
    interrupted = {
        "event_type": "display_guard_interrupted",
        "client_ts": BASE + 100,
        "request_id": str(uuid4()),
        "payload": {
            "profile": "lab_1080p",
            "detected_at": BASE + 350,
            "reasons": ["window_changed"],
        },
    }
    for _ in range(2):
        assert (
            await client.post("/participant/events", headers=participant_headers, json=interrupted)
        ).status_code == 202
    await assert_replay([0], [{"start_ms": 100, "end_ms": ending}])
    during = await export_rows()
    assert [row["mapping_reason"] for row in during] == [""] + ["display_guard_interrupted"] * 5

    # Continuing the pilot without display verification does not certify gaze,
    # even if a later stored layout still carries an earlier verified flag.
    assert (
        await client.post(
            "/participant/events",
            headers=participant_headers,
            json={
                "event_type": "display_guard_continued_unverified",
                "client_ts": BASE + 350,
                "payload": {"profile": "lab_1080p", "reasons": ["window_size"]},
            },
        )
    ).status_code == 202
    await assert_replay([0], [{"start_ms": 100, "end_ms": ending}])
    assert await export_rows() == during

    # An explicit resume in a later page load closes the participant-wide interval.
    resumed = {
        "event_type": "display_guard_resumed",
        "client_ts": BASE + 400,
        "request_id": str(uuid4()),
        "payload": {"profile": "lab_1080p"},
    }
    assert (
        await client.post("/participant/events", headers=participant_headers, json=resumed)
    ).status_code == 202
    # A delayed repeat of the earlier start cannot reopen the interval by arrival order.
    delayed = {**interrupted, "client_ts": BASE + 200, "request_id": str(uuid4())}
    assert (
        await client.post("/participant/events", headers=participant_headers, json=delayed)
    ).status_code == 202
    await assert_replay(
        [0, 400], [{"start_ms": 100, "end_ms": 400}, {"start_ms": 500, "end_ms": ending}]
    )
    after = await export_rows()
    assert [row["mapping_reason"] for row in after] == [
        "",
        "display_guard_interrupted",
        "display_guard_interrupted",
        "display_guard_interrupted",
        "",
        "unverified_display",
    ]
    assert len(after) == len(before) == len(samples)
    for previous, current in zip(before, after, strict=True):
        for key in ("ts", "geometry_ts", "lx", "ly", "rx", "ry", "lv", "rv", "lpd", "rpd"):
            assert current[key] == previous[key]
    recording = await db.get(GazeRecording, recording_id)
    assert recording.sample_count == len(samples)
    assert recording.geometry[0]["display_guard"] == GEOMETRY["display_guard"]
    assert recording.geometry[1]["display_guard"] == geometry["display_guard"]


async def test_guard_events_are_participant_scoped_across_recordings(
    client,
    db,
    seed_study,
    seed_participant,
    participant_headers,
    admin_headers,
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    other = Participant(id="OTHER-GUARD", study_id=seed_study.id)
    questionnaire = Questionnaire(study_id=seed_study.id, placement="pre_test", title="Page")
    db.add_all([other, questionnaire])
    await db.flush()

    db.add(
        InteractionLog(
            participant_id=other.id,
            event_type="display_guard_interrupted",
            client_ts=BASE,
            payload={"profile": "lab_1080p"},
        )
    )
    await db.flush()
    for index in range(2):
        response = await client.post(
            "/gaze/recordings",
            headers=participant_headers,
            json={
                "step_kind": "questionnaire",
                "questionnaire_id": questionnaire.id,
                "step_index": index,
                "sampling_rate_hz": 120,
                "geometry": copy.deepcopy(GEOMETRY),
            },
        )
        assert response.status_code == 201
        recording_id = response.json()["recording_id"]
        assert (
            await client.post(
                f"/gaze/recordings/{recording_id}/samples",
                headers=participant_headers,
                json={"offset": 0, "samples": [sample(index * 100)]},
            )
        ).status_code == 200

    async def reasons():
        response = await client.get(
            f"/admin/studies/{seed_study.id}/export/gaze", headers=admin_headers
        )
        return [
            row["mapping_reason"]
            for row in csv.DictReader(io.StringIO(response.content.decode("utf-8-sig")))
        ]

    assert await reasons() == ["", ""]
    assert (
        await client.post(
            "/participant/events",
            headers=participant_headers,
            json={
                "event_type": "display_guard_interrupted",
                "client_ts": BASE,
                "payload": {"profile": "lab_1080p"},
            },
        )
    ).status_code == 202
    assert await reasons() == ["display_guard_interrupted", "display_guard_interrupted"]
