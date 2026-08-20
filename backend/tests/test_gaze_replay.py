from datetime import UTC, datetime
from itertools import pairwise
from types import SimpleNamespace

from app.services.gaze_replay import (
    build_points,
    geometry_at,
    playback_segments,
    to_video_frame,
)


def _geo(ts=0, video=(0, 0, 1000, 1000), frame=(1000, 1000), screen=(2000, 1000)):
    """A window filling the screen with no chrome, so screen == viewport and the
    arithmetic stays legible: the clip is the left half of a 2000x1000 display."""
    x, y, w, h = video
    return {
        "ts": ts,
        "screen": {"w": screen[0], "h": screen[1]},
        "window": {
            "x": 0,
            "y": 0,
            "outer_w": screen[0],
            "outer_h": screen[1],
            "inner_w": screen[0],
            "inner_h": screen[1],
        },
        "video": {"x": x, "y": y, "w": w, "h": h},
        "frame": {"w": frame[0], "h": frame[1]},
        "dpr": 1,
    }


def _ev(event_type: str, wall_s: float, video_s: float, client_ts: int | None = None):
    return SimpleNamespace(
        event_type=event_type,
        created_at=datetime.fromtimestamp(wall_s, tz=UTC),
        client_ts=client_ts,
        payload={"currentTime": video_s},
    )


def test_single_play_span():
    events = [_ev("video_started", 1000, 0), _ev("video_completed", 1010, 10)]
    segments = playback_segments(events, None)
    assert len(segments) == 1
    ws, we, vs = segments[0]
    assert vs == 0.0
    assert we - ws == 10_000.0  # 10 s in ms


def test_pause_splits_into_two_spans():
    events = [
        _ev("video_started", 1000, 0),
        _ev("video_paused", 1005, 5),
        _ev("video_resumed", 1020, 5),
        _ev("video_completed", 1025, 10),
    ]
    assert len(playback_segments(events, None)) == 2


def test_seek_while_playing_reanchors_the_video_position():
    events = [
        _ev("video_started", 1000, 0),
        _ev("video_seeked", 1002, 50),
        _ev("video_paused", 1004, 52),
    ]
    segments = playback_segments(events, None)
    assert len(segments) == 2
    assert segments[1][2] == 50_000.0  # second span starts at the seeked position


def test_client_ts_wins_over_the_database_timestamp():
    # The browser says the clip ran 1000 -> 1010; the DB rows landed 3 s late.
    events = [
        _ev("video_started", 1003, 0, client_ts=1_000_000),
        _ev("video_completed", 1013, 10, client_ts=1_010_000),
    ]
    ws, we, _ = playback_segments(events, None)[0]
    assert (ws, we) == (1_000_000.0, 1_010_000.0)


def test_created_at_is_the_fallback_when_client_ts_is_absent():
    events = [_ev("video_started", 1000, 0), _ev("video_completed", 1010, 10)]
    ws, we, _ = playback_segments(events, None)[0]
    assert (ws, we) == (1_000_000.0, 1_010_000.0)


def test_open_span_closes_at_the_last_sample():
    events = [_ev("video_started", 1000, 0, client_ts=1_000_000)]
    assert playback_segments(events, 1_007_500.0)[0][1] == 1_007_500.0


def test_open_span_stays_open_without_samples():
    events = [_ev("video_started", 1000, 0, client_ts=1_000_000)]
    assert playback_segments(events, None)[0][1] == float("inf")


def test_build_points_maps_averages_and_filters():
    segments = [(1_000_000.0, 1_010_000.0, 0.0)]  # wall [1e6, 1.01e6] ms -> video 0
    samples = [
        {"ts": 1_001_000, "lx": 0.4, "ly": 0.6, "rx": 0.6, "ry": 0.6},  # -> t=1000, (0.5, 0.6)
        {"ts": 999_000, "lx": 0.5, "ly": 0.5, "rx": 0.5, "ry": 0.5},  # before span -> unmapped
        {"ts": 1_002_000, "lx": None, "ly": None, "rx": None, "ry": None},  # blink -> invalid
    ]
    points, invalid, unmapped, offscreen = build_points(samples, segments)
    assert (invalid, unmapped, offscreen) == (1, 1, 0)
    assert len(points) == 1
    assert points[0] == {"t": 1000, "x": 0.5, "y": 0.6}


def test_screen_centre_is_the_right_edge_of_a_half_width_clip():
    # The clip occupies the left half of the display, so gaze at screen x=0.5
    # sits on the clip's right edge — not at its centre, which is what plotting
    # the raw coordinate would have claimed.
    assert to_video_frame(0.5, 0.5, _geo()) == (1.0, 0.5)


def test_gaze_on_the_notes_rail_is_off_the_clip():
    assert to_video_frame(0.8, 0.5, _geo()) is None


def test_letterboxing_is_taken_out():
    # A 1000x500 clip inside a 1000x1000 element leaves 250px bars top and
    # bottom; the top of the picture is a quarter of the way down the element.
    geo = _geo(video=(0, 0, 1000, 1000), frame=(1000, 500))
    assert to_video_frame(0.0, 0.25, geo) == (0.0, 0.0)
    assert to_video_frame(0.0, 0.5, geo) == (0.0, 0.5)
    assert to_video_frame(0.0, 0.1, geo) is None  # in the black bar


def test_browser_chrome_shifts_the_viewport_down():
    geo = _geo()
    geo["window"] |= {"y": 0, "outer_h": 1000, "inner_h": 900}  # 100px of chrome on top
    geo["video"] = {"x": 0, "y": 0, "w": 1000, "h": 900}
    geo["frame"] = {"w": 1000, "h": 900}
    # Screen y=100 is the first row of the viewport, so the top of the clip.
    assert to_video_frame(0.0, 0.1, geo) == (0.0, 0.0)


def test_offset_element_is_accounted_for():
    geo = _geo(video=(500, 250, 500, 500), frame=(500, 500))
    assert to_video_frame(0.25, 0.25, geo) == (0.0, 0.0)  # screen (500, 250)
    assert to_video_frame(0.5, 0.75, geo) == (1.0, 1.0)  # screen (1000, 750)


def test_a_degenerate_geometry_maps_nothing():
    assert to_video_frame(0.5, 0.5, _geo(video=(0, 0, 0, 0))) is None


def test_geometry_at_picks_the_layout_in_force():
    snaps = [_geo(ts=100), _geo(ts=200), _geo(ts=300)]
    assert geometry_at(snaps, 50)["ts"] == 100  # before the first: use the first
    assert geometry_at(snaps, 250)["ts"] == 200
    assert geometry_at(snaps, 9999)["ts"] == 300
    assert geometry_at([], 250) is None


def test_build_points_counts_gaze_that_left_the_clip():
    segments = [(1_000_000.0, 1_010_000.0, 0.0)]
    samples = [
        {"ts": 1_001_000, "lx": 0.25, "ly": 0.5, "rx": 0.25, "ry": 0.5},  # on the clip
        {"ts": 1_002_000, "lx": 0.9, "ly": 0.5, "rx": 0.9, "ry": 0.5},  # on the rail
    ]
    points, invalid, unmapped, offscreen = build_points(samples, segments, [_geo()])
    assert (invalid, unmapped, offscreen) == (0, 0, 1)
    assert points == [{"t": 1000, "x": 0.5, "y": 0.5}]


def test_segment_lookup_bisects_instead_of_scanning():
    from app.services.gaze_replay import segment_at

    segments = [(0.0, 100.0, 0.0), (200.0, 300.0, 100.0), (400.0, 500.0, 200.0)]
    starts = [s[0] for s in segments]

    assert segment_at(segments, starts, 50) == segments[0]
    assert segment_at(segments, starts, 250) == segments[1]
    assert segment_at(segments, starts, 450) == segments[2]
    assert segment_at(segments, starts, -1) is None  # before everything
    assert segment_at(segments, starts, 150) is None  # in a pause between spans
    assert segment_at(segments, starts, 900) is None  # after the last span ended


def test_many_segments_stay_fast():
    # 2000 spans and 50k samples: the old per-sample scan made this quadratic.
    segments = [(float(i * 100), float(i * 100 + 50), float(i * 10)) for i in range(2000)]
    samples = [{"ts": i * 4, "lx": 0.5, "ly": 0.5, "rx": 0.5, "ry": 0.5} for i in range(50_000)]

    points, _, _, _ = build_points(samples, segments)
    assert points  # and it returns rather than hanging


def test_downsample_thins_to_what_a_screen_can_show():
    from app.services.gaze_replay import downsample

    # 120 Hz for ten seconds.
    points = [{"t": i * 8, "x": 0.5, "y": 0.5} for i in range(1250)]
    thinned = downsample(points, min_gap_ms=20, max_points=8000)

    assert len(thinned) < len(points)
    assert all(b["t"] - a["t"] >= 20 for a, b in pairwise(thinned))
    assert thinned[0] == points[0]


def test_downsample_respects_the_hard_cap():
    from app.services.gaze_replay import downsample

    points = [{"t": i * 1000, "x": 0.5, "y": 0.5} for i in range(20_000)]
    assert len(downsample(points, min_gap_ms=20, max_points=100)) <= 100


def test_downsample_leaves_a_short_recording_alone():
    from app.services.gaze_replay import downsample

    points = [{"t": i * 100, "x": 0.5, "y": 0.5} for i in range(10)]
    assert downsample(points) == points
    assert downsample([]) == []
