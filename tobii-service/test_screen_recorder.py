"""The clock anchor, which is the whole reason the capture lives in the bridge.

Everything the replay does with a screen recording is `sample_ts - epoch_ms`,
so an anchor that is off by a second puts the gaze dot a second out for the
entire case. These cover the arithmetic; the capture itself needs ffmpeg and a
screen and is checked by running it.
"""

from __future__ import annotations

import asyncio
import platform

import pytest

from screen_recorder import (
    ScreenRecorder,
    ScreenRecordingError,
    _ffmpeg_command,
    parse_macos_screen_device,
)
from tobii_bridge import wants_test_pattern


def _progress(out_time_us: int) -> bytes:
    return f"frame=1\nfps=30\nout_time_us={out_time_us}\nprogress=continue\n".encode()


async def _drain(recorder: ScreenRecorder, chunks: list[bytes]) -> None:
    """Run the progress reader over a canned ffmpeg -progress stream."""
    stream = asyncio.StreamReader()
    for chunk in chunks:
        stream.feed_data(chunk)
    stream.feed_eof()

    class _Proc:
        stdout = stream
        returncode = None

    recorder._proc = _Proc()  # type: ignore[assignment]
    await recorder._read_progress()


@pytest.mark.asyncio
async def test_the_anchor_is_now_minus_how_far_in_ffmpeg_is(monkeypatch):
    monkeypatch.setattr("screen_recorder.time.time", lambda: 1_000.0)
    recorder = ScreenRecorder()
    # ffmpeg is 2 s into the output, so the output started at 998 s.
    await _drain(recorder, [_progress(2_000_000)])
    assert recorder._progress.anchor_ms == pytest.approx(998_000)


@pytest.mark.asyncio
async def test_the_anchor_keeps_the_least_lagged_reading(monkeypatch):
    """Encoding runs behind the capture and never ahead, so every reading is the
    true start *plus* some lag. The smallest one is the best estimate."""
    now = iter([1_000.0, 1_001.0, 1_002.0])
    monkeypatch.setattr("screen_recorder.time.time", lambda: next(now))
    recorder = ScreenRecorder()
    await _drain(
        recorder,
        [
            _progress(2_000_000),  # 1000 - 2.0 = 998.0
            _progress(3_000_000),  # 1001 - 3.0 = 998.0
            _progress(3_500_000),  # 1002 - 3.5 = 998.5  <- lagged half a second
        ],
    )
    assert recorder._progress.anchor_ms == pytest.approx(998_000)


@pytest.mark.asyncio
async def test_duration_is_the_furthest_ffmpeg_got(monkeypatch):
    monkeypatch.setattr("screen_recorder.time.time", lambda: 1_000.0)
    recorder = ScreenRecorder()
    await _drain(recorder, [_progress(1_000_000), _progress(9_000_000)])
    assert recorder._progress.duration_ms == 9_000


@pytest.mark.asyncio
async def test_no_anchor_before_the_first_frame(monkeypatch):
    """ffmpeg reports `out_time_us=N/A`, then 0, until frames actually flow."""
    monkeypatch.setattr("screen_recorder.time.time", lambda: 1_000.0)
    recorder = ScreenRecorder()
    await _drain(recorder, [b"out_time_us=N/A\n", _progress(0)])
    assert recorder._progress.anchor_ms is None


def test_the_capture_draws_the_cursor():
    """Without this the mouse is not in the recording, which is half the point."""
    command = _ffmpeg_command(
        out=__import__("pathlib").Path("out.mp4"),
        fps=30,
        crf=28,
        max_height=1080,
        device="screen",
        test_pattern=False,
    )
    cursor_flag = {"Windows": "-draw_mouse", "Darwin": "-capture_cursor"}.get(
        platform.system(), "-draw_mouse"
    )
    assert cursor_flag in command
    assert command[command.index(cursor_flag) + 1] == "1"
    # And the anchor needs ffmpeg to keep saying where it is.
    assert "-progress" in command and command[command.index("-progress") + 1] == "pipe:1"


def test_the_capture_never_upscales_a_smaller_display():
    command = _ffmpeg_command(
        out=__import__("pathlib").Path("out.mp4"),
        fps=30,
        crf=28,
        max_height=1080,
        device="screen",
        test_pattern=False,
    )
    assert command[command.index("-vf") + 1] == "scale=-2:'min(1080,ih)'"


# What `ffmpeg -f avfoundation -list_devices true -i ""` prints on a MacBook with
# a Continuity camera paired: four cameras before the display.
MACOS_LISTING = """[AVFoundation indev @ 0x844c18140] AVFoundation video devices:
[AVFoundation indev @ 0x844c18140] [0] MacBook Air Camera
[AVFoundation indev @ 0x844c18140] [1] Altin Camera
[AVFoundation indev @ 0x844c18140] [2] MacBook Air Desk View Camera
[AVFoundation indev @ 0x844c18140] [3] Altin Desk View Camera
[AVFoundation indev @ 0x844c18140] [4] Capture screen 0
[AVFoundation indev @ 0x844c18140] AVFoundation audio devices:
[AVFoundation indev @ 0x844c18140] [0] Altin Microphone
[AVFoundation indev @ 0x844c18140] [1] MacBook Air Microphone
"""


def test_the_screen_is_found_behind_the_cameras():
    """The old default of "1:none" recorded the participant's face on this
    machine, and a camera capture succeeds — nothing would have flagged it."""
    assert parse_macos_screen_device(MACOS_LISTING) == "4:none"


def test_audio_devices_cannot_be_mistaken_for_a_screen():
    """They are numbered from zero again, so reading past the video section
    would pick an index that means something else entirely."""
    listing = MACOS_LISTING.replace("[1] MacBook Air Microphone", "[1] Capture screen 9")
    assert parse_macos_screen_device(listing) == "4:none"


def test_no_screen_in_the_listing_is_not_a_guess():
    cameras_only = "\n".join(MACOS_LISTING.splitlines()[:5])
    assert parse_macos_screen_device(cameras_only) is None


@pytest.mark.asyncio
async def test_macos_refuses_to_record_rather_than_guess_an_index(monkeypatch):
    monkeypatch.setattr("screen_recorder.platform.system", lambda: "Darwin")
    monkeypatch.setattr("screen_recorder.shutil.which", lambda _: "/usr/bin/ffmpeg")
    monkeypatch.setattr("screen_recorder.macos_screen_device", lambda: _none())

    with pytest.raises(ScreenRecordingError, match="screen index"):
        await ScreenRecorder().start()


async def _none() -> None:
    return None


@pytest.mark.asyncio
async def test_an_explicit_device_skips_the_probe(monkeypatch):
    """--screen-device is the escape hatch when the probe cannot help."""
    monkeypatch.setattr("screen_recorder.platform.system", lambda: "Darwin")

    async def _fail() -> None:
        raise AssertionError("probed despite being told the device")

    monkeypatch.setattr("screen_recorder.macos_screen_device", _fail)
    recorder = ScreenRecorder(device="4:none")
    await recorder._resolve_device()
    assert recorder.device == "4:none"


def test_mock_gaze_can_be_paired_with_a_real_screen_capture():
    """On a laptop there is no tracker, so mock gaze is the only gaze there is —
    and the test pattern shows none of the interaction the replay is for."""
    assert wants_test_pattern("auto", mock=True) is True
    assert wants_test_pattern("auto", mock=False) is False
    assert wants_test_pattern("display", mock=True) is False
    assert wants_test_pattern("test-pattern", mock=False) is True
