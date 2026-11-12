from __future__ import annotations

import asyncio
import json
import shutil
import socket
import time
from pathlib import Path

import pytest
import websockets

from screen_recorder import Recording, ScreenRecorder, ScreenRecordingError
from stimulus_audio import StimulusAudio
from tobii_bridge import DEFAULT_ORIGINS, Destination, ScreenSession, _serve


class FakeRecorder:
    def __init__(self, folder: Path, start_gate=None, stop_gate=None):
        self.folder = folder
        folder.mkdir()
        self.path = folder / "screen.mp4"
        self.path.write_bytes(b"recorded screen")
        self.audio = None
        self.start_gate = start_gate
        self.stop_gate = stop_gate
        self.discarded = False
        self.stops = 0

    async def start(self):
        if self.start_gate:
            await self.start_gate.wait()

    async def stop(self):
        self.stops += 1
        if self.stop_gate:
            await self.stop_gate.wait()
        return Recording(self.path, 123456, 1000)

    def discard(self):
        self.discarded = True
        shutil.rmtree(self.folder)


def destination():
    return {"upload_url": "http://api/upload", "token": "one-recording-token"}


@pytest.mark.asyncio
async def test_start_and_stop_reserve_the_screen_against_concurrent_owners(tmp_path, monkeypatch):
    ready, stopped = asyncio.Event(), asyncio.Event()
    recorder = FakeRecorder(tmp_path / "capture", ready, stopped)
    created, uploaded = [], []

    def make(**options):
        created.append(options)
        return recorder

    async def upload(*args):
        uploaded.append(args)

    monkeypatch.setattr("tobii_bridge.ScreenRecorder", make)
    monkeypatch.setattr("tobii_bridge.upload_recording", upload)
    monkeypatch.setattr("tobii_bridge.shutil.which", lambda _: "tool")
    screen = ScreenSession({}, tmp_path / "unsent")
    owner, other = object(), object()
    starting = asyncio.create_task(screen.start(owner, destination()))
    await asyncio.sleep(0)
    assert not (await screen.start(other, destination()))[0]
    assert not (await screen.stop(other))[0]
    assert not (await screen.stop(owner))[0]
    await screen.release(other)
    assert len(created) == 1
    ready.set()
    assert await starting == (True, None)
    stopping = asyncio.create_task(screen.stop(owner))
    await asyncio.sleep(0)
    assert not (await screen.start(other, destination()))[0]
    assert not (await screen.stop(owner))[0]
    assert recorder.stops == 1
    stopped.set()
    assert await stopping == (True, None)
    await screen.drain()
    assert len(uploaded) == 1
    assert screen.owner is None and screen.recorder is None
    assert recorder.discarded


@pytest.mark.asyncio
async def test_cancelled_start_releases_ownership(tmp_path, monkeypatch):
    recorder = FakeRecorder(tmp_path / "capture", asyncio.Event())
    monkeypatch.setattr("tobii_bridge.ScreenRecorder", lambda **_: recorder)
    monkeypatch.setattr("tobii_bridge.shutil.which", lambda _: "tool")
    screen = ScreenSession({}, tmp_path / "unsent")
    task = asyncio.create_task(screen.start(object(), destination()))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert screen.owner is None and screen.recorder is None
    assert not screen._starting
    assert recorder.discarded


@pytest.mark.asyncio
async def test_failed_start_does_not_lock_out_the_next_case(tmp_path, monkeypatch):
    recorder = FakeRecorder(tmp_path / "capture")

    async def fail():
        raise RuntimeError("permission refused")

    recorder.start = fail
    monkeypatch.setattr("tobii_bridge.ScreenRecorder", lambda **_: recorder)
    monkeypatch.setattr("tobii_bridge.shutil.which", lambda _: "tool")
    screen = ScreenSession({}, tmp_path / "unsent")
    assert await screen.start(object(), destination()) == (False, "permission refused")
    assert screen.recorder is None and screen.owner is None
    assert not screen._starting
    assert recorder.discarded


@pytest.mark.asyncio
async def test_disconnect_preserves_video_but_marks_incomplete_audio_failed(tmp_path, monkeypatch):
    recorder = FakeRecorder(tmp_path / "capture")
    recorder.audio = StimulusAudio(recorder.folder)
    recorder.audio.start({"mime_type": "audio/webm", "epoch_ms": int(time.time() * 1000)})
    recorder.audio.append(b"interrupted audio")
    uploaded = []

    async def upload(recording, *args):
        uploaded.append(
            (recording.audio_status, recording.audio_error, recording.path.read_bytes())
        )

    monkeypatch.setattr("tobii_bridge.upload_recording", upload)
    screen = ScreenSession({}, tmp_path / "unsent")
    screen.owner = object()
    screen.recorder = recorder
    await screen.release(screen.owner)
    await screen.drain()
    assert len(uploaded) == 1
    status, error, content = uploaded[0]
    assert status == "failed" and "final chunk" in error
    assert content == b"recorded screen"
    assert recorder.discarded


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_unsent_recordings_survive_upload_failure_and_name_collisions(
    tmp_path, monkeypatch, direct
):
    reported, calls = [], []

    async def upload(*args):
        calls.append(args)
        raise RuntimeError("network unavailable")

    async def report(*args):
        reported.append(args)

    monkeypatch.setattr("tobii_bridge.upload_recording", upload)
    monkeypatch.setattr("tobii_bridge.report_failure", report)
    screen = ScreenSession({}, tmp_path / "unsent")
    dest = Destination(
        "upload", "failure", "session" if direct else "", "complete" if direct else "", "token"
    )
    for i in range(2):
        recorder = FakeRecorder(tmp_path / f"capture{i}")
        recorder.path.write_bytes(str(i).encode())
        await screen._deliver(recorder, await recorder.stop(), dest)
        assert recorder.discarded
    assert sorted(path.read_bytes() for path in screen.keep_dir.glob("*.mp4")) == [b"0", b"1"]
    assert len(reported) == 2
    assert all("file is on the lab machine" in args[2] for args in reported)
    assert calls[0][3:] == (("session", "complete") if direct else ("", ""))


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["mkdir", "move"])
async def test_failed_recovery_preserves_temp_file_and_reports_its_path(
    tmp_path, monkeypatch, failure
):
    recorder = FakeRecorder(tmp_path / "capture")
    screen = ScreenSession({}, tmp_path / "unsent")
    reported = []

    async def upload(*args):
        raise RuntimeError("upload refused")

    async def report(*args):
        reported.append(args)

    def move(*args):
        raise OSError("disk full")

    monkeypatch.setattr("tobii_bridge.upload_recording", upload)
    monkeypatch.setattr("tobii_bridge.report_failure", report)
    if failure == "mkdir":
        screen.keep_dir.write_bytes(b"not a folder")
    else:
        monkeypatch.setattr("tobii_bridge.shutil.move", move)
    await screen._deliver(
        recorder, await recorder.stop(), Destination("upload", "failed", token="token")
    )
    assert recorder.path.read_bytes() == b"recorded screen"
    assert not recorder.discarded
    assert len(reported) == 1
    assert str(recorder.path) in reported[0][2]


@pytest.mark.asyncio
async def test_cancelled_real_ffmpeg_start_kills_process_and_removes_temp_files(monkeypatch):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg unavailable")
    recorder = ScreenRecorder(test_pattern=True, max_height=180, fps=10)
    entered = asyncio.Event()

    async def wait_forever():
        entered.set()
        await asyncio.Future()

    monkeypatch.setattr(recorder, "_await_anchor", wait_forever)
    task = asyncio.create_task(recorder.start())
    await entered.wait()
    proc, folder = recorder._proc, recorder._dir
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert proc.returncode is not None
    assert not folder.exists()
    assert recorder._proc is None and recorder._tasks == []


@pytest.mark.asyncio
async def test_real_recording_stops_with_clock_and_geometry_then_cleans_up():
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg and ffprobe required")
    recorder = ScreenRecorder(test_pattern=True, max_height=180, fps=10)
    try:
        await recorder.start()
        assert recorder.running
        recording = await recorder.stop()
        assert recording.path.is_file()
        assert recording.epoch_ms > 0
        assert recording.duration_ms > 0
        assert (recording.width, recording.height) == (320, 180)
        assert not recorder.running
    finally:
        recorder.discard()
    assert not recording.path.exists()


@pytest.mark.asyncio
async def test_navigation_can_close_before_stop_ack_without_losing_upload(
    tmp_path, monkeypatch, caplog
):
    gate, uploaded = asyncio.Event(), asyncio.Event()
    recorder = FakeRecorder(tmp_path / "capture", stop_gate=gate)
    monkeypatch.setattr("tobii_bridge.ScreenRecorder", lambda **_: recorder)
    monkeypatch.setattr("tobii_bridge.shutil.which", lambda _: "tool")

    async def upload(*args):
        uploaded.set()

    monkeypatch.setattr("tobii_bridge.upload_recording", upload)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    session = ScreenSession({}, tmp_path / "unsent")
    server = asyncio.create_task(_serve(port, "127.0.0.1", True, set(DEFAULT_ORIGINS), session))
    try:
        for _ in range(100):
            try:
                ws = await websockets.connect(
                    f"ws://127.0.0.1:{port}", origin="https://a04.rdm.lab.lrz.de"
                )
                break
            except OSError:
                await asyncio.sleep(0.01)
        else:
            pytest.fail("bridge did not start")
        try:
            await ws.recv()
            await ws.send(json.dumps({"type": "start_screen_recording", **destination()}))
            assert json.loads(await ws.recv())["ok"] is True
            await ws.send(json.dumps({"type": "stop_screen_recording"}))
            await ws.close()
        finally:
            await ws.close()
        gate.set()
        await asyncio.wait_for(uploaded.wait(), 1)
        await session.drain()
        await asyncio.sleep(0)
        assert not any(record.exc_info for record in caplog.records)
        assert recorder.discarded and session.owner is None
    finally:
        gate.set()
        server.cancel()
        with pytest.raises(asyncio.CancelledError):
            await server


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_interrupted_recorder_stop_kills_child_and_discards_unusable_file(
    tmp_path, monkeypatch, cancel
):
    killed = asyncio.Event()
    waiting = asyncio.Event()

    class Process:
        stdin = None
        returncode = None

        async def wait(self):
            waiting.set()
            await killed.wait()
            return self.returncode

        def kill(self):
            self.returncode = -9
            killed.set()

    recorder = ScreenRecorder()
    recorder._proc = Process()
    recorder._dir = tmp_path / "capture"
    recorder._dir.mkdir()
    recorder._path = recorder._dir / "screen.mp4"
    recorder._path.write_bytes(b"incomplete video")
    if not cancel:
        monkeypatch.setattr("screen_recorder.STOP_TIMEOUT_S", 0.001)
    task = asyncio.create_task(recorder.stop())
    await waiting.wait()
    if cancel:
        task.cancel()
    with pytest.raises(asyncio.CancelledError if cancel else ScreenRecordingError):
        await task
    assert killed.is_set()
    assert recorder._proc is None
    assert not (tmp_path / "capture").exists()


@pytest.mark.asyncio
async def test_reporting_stop_failure_does_not_block_or_erase_the_next_case(tmp_path, monkeypatch):
    old = FakeRecorder(tmp_path / "old")
    new = FakeRecorder(tmp_path / "new")
    reporting, finish_report = asyncio.Event(), asyncio.Event()

    async def fail():
        raise RuntimeError("encoder crashed")

    async def report(*args):
        reporting.set()
        await finish_report.wait()

    old.stop = fail
    screen = ScreenSession({}, tmp_path / "unsent")
    screen.recorder, screen.owner = old, object()
    monkeypatch.setattr(screen, "_report", report)
    monkeypatch.setattr("tobii_bridge.ScreenRecorder", lambda **_: new)
    monkeypatch.setattr("tobii_bridge.shutil.which", lambda _: "tool")
    stopping = asyncio.create_task(screen.stop(screen.owner))
    await reporting.wait()
    next_owner = object()
    assert await screen.start(next_owner, destination()) == (True, None)
    finish_report.set()
    assert await stopping == (False, "encoder crashed")
    assert screen.recorder is new and screen.owner is next_owner
    new.discard()
