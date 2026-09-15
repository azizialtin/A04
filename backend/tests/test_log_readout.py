"""The export's human-readable columns: timecodes, and the step a row is about."""

import pytest

from app.services.log_data import (
    completed_step_label,
    playhead_seconds,
    seek_origin_seconds,
    step_label,
)
from app.services.timecode import timecode


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [
        (0, "00:00"),
        (9.499047, "00:09"),  # truncated, like the player's own clock
        (45, "00:45"),
        (65.5, "01:05"),
        (3600, "1:00:00"),
        (3725.9, "1:02:05"),
        (-1, "00:00"),
        (None, ""),
        (float("nan"), ""),
    ],
)
def test_a_video_position_reads_as_a_timecode(seconds, expected):
    assert timecode(seconds) == expected


def test_the_playhead_is_found_wherever_an_event_put_it():
    assert playhead_seconds({"currentTime": 9.5, "from": 0.7, "to": 9.5}) == 9.5
    assert seek_origin_seconds({"currentTime": 9.5, "from": 0.7, "to": 9.5}) == 0.7
    # A note names it the way the notes API does.
    assert playhead_seconds({"video_time_seconds": 4.25}) == 4.25
    assert playhead_seconds({"durationMs": 800}) is None
    assert playhead_seconds(None) is None
    # JSON "true" is an int in Python and would otherwise read as one second in.
    assert playhead_seconds({"currentTime": True}) is None


def test_a_step_is_named_by_what_it_showed():
    assert (
        step_label(
            {"kind": "questionnaire", "title": "Angaben zur Person", "page": 2, "page_count": 3}
        )
        == "questionnaire: Angaben zur Person (page 2/3)"
    )
    # A single-page battery does not need counting.
    assert (
        step_label({"kind": "questionnaire", "title": "Sicherheit", "page": 1, "page_count": 1})
        == "questionnaire: Sicherheit"
    )
    assert step_label({"kind": "case_video", "title": "Fall 3"}) == "case_video: Fall 3"
    assert step_label({"kind": "sosci", "variant": "posttest"}) == "sosci: posttest"
    assert step_label({"kind": "phase_transition", "phase_type": "training"}) == (
        "phase_transition: training"
    )
    assert step_label({"kind": "welcome"}) == "welcome"


def test_a_row_from_before_the_descriptor_existed_stays_blank():
    assert completed_step_label({"current_step_index": 1, "total_steps": 12}) == ""
    assert completed_step_label({"completed_step": None}) == ""
    assert completed_step_label(None) == ""
    assert step_label({"title": "no kind"}) == ""
