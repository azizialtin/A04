from __future__ import annotations

import asyncio
import json
import math
import shutil
import struct
import subprocess
import time
from types import SimpleNamespace

import pytest
import websockets

from screen_recorder import Recording
from stimulus_audio import MAX_CHUNK_BYTES, StimulusAudio, has_audio_packets
from tobii_bridge import DEFAULT_ORIGINS, ScreenSession, _serve


def start(audio, epoch=None):
    return audio.start(
        {"epoch_ms": epoch or int(time.time() * 1000), "mime_type": "audio/webm;codecs=opus"}
    )


def test_audio_transfer_rejects_wrong_owner_and_preserves_active_capture(tmp_path, monkeypatch):
    monkeypatch.setattr("tobii_bridge.shutil.which", lambda _: "tool")
    session = ScreenSession({}, tmp_path)
    owner = object()
    session.owner = owner
    audio = StimulusAudio(tmp_path)
    session.recorder = SimpleNamespace(audio=audio)
    assert session.audio_message(object(), "chunk", b"private") is not None
    assert audio.path is None
    assert (
        session.audio_message(
            owner,
            "start_stimulus_audio",
            {"epoch_ms": int(time.time() * 1000), "mime_type": "audio/webm"},
        )
        is None
    )
    assert session.audio_message(owner, "chunk", b"sound") is None
    assert audio.path.read_bytes() == b"sound"


@pytest.mark.parametrize("epoch", [None, True, "123", float("nan"), -1, 10**400])
def test_invalid_audio_clocks_are_detected(tmp_path, epoch):
    audio = StimulusAudio(tmp_path)
    assert audio.start({"epoch_ms": epoch, "mime_type": "audio/webm"})
    assert audio.status == "failed"


def test_malformed_finish_result_is_a_reported_failure(tmp_path):
    audio = StimulusAudio(tmp_path)
    assert audio.finish({"audio_status": []})
    assert audio.status == "failed"


def test_invalid_audio_formats_and_transfer_limits_are_detected(tmp_path):
    audio = StimulusAudio(tmp_path)
    assert audio.start({"epoch_ms": int(time.time() * 1000), "mime_type": "video/mp4"})
    audio = StimulusAudio(tmp_path)
    assert start(audio) is None
    assert audio.append(b"x" * (MAX_CHUNK_BYTES + 1))
    assert audio.size == 0
    assert audio.finish({"audio_status": "captured"})
    assert audio.status == "failed"


@pytest.mark.asyncio
async def test_missing_and_interrupted_audio_keep_video_and_report_failure(tmp_path):
    video = tmp_path / "screen.mp4"
    video.write_bytes(b"the original screen")
    recording = Recording(video, int(time.time() * 1000), 3000)
    audio = StimulusAudio(tmp_path)
    await audio.attach(recording)
    assert recording.audio_status == "unavailable"
    assert start(audio) is None
    assert audio.append(b"unfinished") is None
    await audio.attach(recording)
    assert recording.audio_status == "failed"
    assert "final chunk" in recording.audio_error
    assert video.read_bytes() == b"the original screen"


@pytest.mark.asyncio
async def test_encoded_audio_is_verified_before_claiming_success(tmp_path):
    if not shutil.which("ffprobe"):
        pytest.skip("ffprobe unavailable")
    video = tmp_path / "screen.mp4"
    video.write_bytes(b"screen")
    recording = Recording(video, int(time.time() * 1000), 3000)
    audio = StimulusAudio(tmp_path)
    start(audio)
    audio.append(b"this is not encoded audio")
    audio.finish({"audio_status": "captured"})
    await audio.attach(recording)
    assert recording.audio_status == "failed"
    assert video.read_bytes() == b"screen"


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def video_hash(path):
    return subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-f",
            "hash",
            "-hash",
            "sha256",
            "-",
        ]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("offset", [-500, 500])
async def test_mux_preserves_video_clock_and_real_sound_silence_sequence(tmp_path, offset):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg and ffprobe required")
    video = tmp_path / "screen.mp4"
    sound = tmp_path / "live.webm"
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=black:size=160x90:rate=10",
        "-t",
        "5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(video),
    )
    # Delay, first passage, a pause, then the same passage played again.
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=if(between(t\\,1\\,2)+between(t\\,3\\,4)\\,0.2*sin(2*PI*440*t)\\,0):s=48000:d=5",
        "-c:a",
        "libopus",
        str(sound),
    )
    before = video_hash(video)
    epoch = int(time.time() * 1000)
    recording = Recording(video, epoch, 5000)
    audio = StimulusAudio(tmp_path)
    assert start(audio, epoch + offset) is None
    data = sound.read_bytes()
    for pos in range(0, len(data), MAX_CHUNK_BYTES):
        assert audio.append(data[pos : pos + MAX_CHUNK_BYTES]) is None
    assert audio.finish({"audio_status": "captured"}) is None
    await audio.attach(recording)
    assert recording.audio_status == "captured", recording.audio_error
    assert recording.epoch_ms == epoch
    assert recording.duration_ms == 5000
    assert video_hash(video) == before
    assert await has_audio_packets(video)
    decoded = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(video),
            "-map",
            "0:a:0",
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-",
        ]
    )
    samples = struct.unpack(f"<{len(decoded) // 4}f", decoded)

    def rms(at):
        window = samples[int(at * 8000) : int((at + 0.1) * 8000)]
        return math.sqrt(sum(s * s for s in window) / len(window))

    shift = offset / 1000
    assert rms(1.3 + shift) > 0.05
    assert rms(2.3 + shift) < 0.001
    assert rms(3.3 + shift) > 0.05
    assert rms(4.3 + shift) < 0.001


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "denied_origin",
    [
        None,
        "https://unrelated.example",
        "https://a04.drm.lab.lrz.de",  # The previously misread hostname is not the study.
        "https://a04.rdm.lab.lrz.de.attacker.example",
    ],
)
async def test_lrz_origin_can_stream_and_unrelated_origin_is_refused(tmp_path, denied_origin):
    # A real websocket handshake catches allowlist regressions before packaging.
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    session = ScreenSession({"disabled": True}, tmp_path)
    task = asyncio.create_task(_serve(port, "127.0.0.1", True, set(DEFAULT_ORIGINS), session))
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
            status = json.loads(await ws.recv())
            assert status["type"] == "status"
            assert status["connected"] is True
            for malformed in ("not json", "[]", '{"type": []}'):
                await ws.send(malformed)
            await ws.send(b"unsolicited audio")
            assert json.loads(await ws.recv())["type"] == "stimulus_audio_error"
            await ws.send(json.dumps({"type": "start_gaze"}))
            assert json.loads(await asyncio.wait_for(ws.recv(), 1))["type"] == "gaze"
        finally:
            await ws.close()
        async with websockets.connect(f"ws://127.0.0.1:{port}", origin=denied_origin) as denied:
            with pytest.raises(websockets.exceptions.ConnectionClosedError) as exc:
                await denied.recv()
            assert exc.value.rcvd.code == 4403
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_final_sound_is_not_trimmed_to_lagging_encoder_progress(tmp_path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg and ffprobe required")
    video = tmp_path / "screen.mp4"
    sound = tmp_path / "live.webm"
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=black:size=160x90:rate=10",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(video),
    )
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-af",
        "adelay=1800:all=1",
        "-c:a",
        "libopus",
        str(sound),
    )
    epoch = int(time.time() * 1000)
    recording = Recording(video, epoch, 1800)
    audio = StimulusAudio(tmp_path)
    start(audio, epoch)
    audio.append(sound.read_bytes())
    audio.finish({"audio_status": "captured"})
    await audio.attach(recording)
    assert recording.audio_status == "captured", recording.audio_error
    assert recording.duration_ms == 1800
    decoded = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(video),
            "-map",
            "0:a:0",
            "-ss",
            "1.9",
            "-t",
            "0.05",
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-",
        ]
    )
    samples = struct.unpack(f"<{len(decoded) // 4}f", decoded)
    assert len(samples) >= 350
    assert math.sqrt(sum(s * s for s in samples) / len(samples)) > 0.02


def test_duplicate_messages_and_aggregate_overflow_are_terminal_failures(tmp_path, monkeypatch):
    import stimulus_audio

    audio = StimulusAudio(tmp_path)
    assert start(audio) is None
    assert start(audio)
    assert audio.append(b"bytes")
    assert audio.status == "failed"
    audio = StimulusAudio(tmp_path)
    assert start(audio) is None
    monkeypatch.setattr(stimulus_audio, "MAX_AUDIO_BYTES", 10)
    assert audio.append(b"12345678") is None
    assert audio.append(b"abcd")
    assert audio.path.read_bytes() == b"12345678"
    assert audio.finish({"audio_status": "captured"})
    assert audio.status == "failed"


def test_audio_cannot_continue_after_finalization(tmp_path):
    audio = StimulusAudio(tmp_path)
    assert start(audio) is None
    audio.append(b"encoded bytes")
    assert audio.finish({"audio_status": "silent"}) is None
    assert audio.append(b"late bytes")
    assert audio.finish({"audio_status": "captured"})
    assert audio.status == "failed"


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_failure", ["probe", "mux", "codec", "packets"])
async def test_tool_failures_never_replace_the_original_video(tmp_path, monkeypatch, tool_failure):
    import stimulus_audio

    video = tmp_path / "screen.mp4"
    video.write_bytes(b"original video")
    recording = Recording(video, int(time.time() * 1000), 1000)
    audio = StimulusAudio(tmp_path)
    start(audio, recording.epoch_ms)
    audio.append(b"audio bytes")
    audio.finish({"audio_status": "captured"})

    async def run(*args, **kwargs):
        if args[0] == "ffprobe":
            if tool_failure == "probe":
                raise FileNotFoundError("ffprobe missing")
            if "stream=duration" in args:
                return b'{"streams": [{"duration": "1.000"}]}'
            if tool_failure == "packets":
                return b'{"streams": []}'
            return b'{"streams": [{"nb_read_packets": "20"}]}'
        raise RuntimeError("Unknown encoder 'aac'" if tool_failure == "codec" else "mux failed")

    monkeypatch.setattr(stimulus_audio, "_run", run)
    await audio.attach(recording)
    assert recording.audio_status == "failed"
    assert recording.audio_error
    assert video.read_bytes() == b"original video"


@pytest.mark.asyncio
async def test_real_truncated_opus_input_is_not_silently_padded_and_called_captured(tmp_path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg and ffprobe required")
    sound = tmp_path / "sound.webm"
    ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", str(sound))
    video = tmp_path / "screen.mp4"
    video.write_bytes(b"original video")
    recording = Recording(video, int(time.time() * 1000), 2000)
    audio = StimulusAudio(tmp_path)
    start(audio, recording.epoch_ms)
    content = sound.read_bytes()
    audio.append(content[: len(content) // 2])
    audio.finish({"audio_status": "captured"})
    await audio.attach(recording)
    assert recording.audio_status == "failed"
    assert "prematurely" in recording.audio_error
    assert video.read_bytes() == b"original video"


@pytest.mark.asyncio
async def test_media_subprocess_timeout_kills_child(monkeypatch):
    import stimulus_audio

    class Process:
        returncode = None
        killed = False

        async def communicate(self):
            await asyncio.Future()

        def kill(self):
            self.killed = True
            self.returncode = -9

        async def wait(self):
            return self.returncode

    proc = Process()

    async def create(*args, **kwargs):
        return proc

    monkeypatch.setattr(stimulus_audio.asyncio, "create_subprocess_exec", create)
    with pytest.raises(asyncio.TimeoutError):
        await stimulus_audio._run("ffmpeg", timeout=0.001)
    assert proc.killed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "diagnostic,accepted",
    [
        (b"[opus @ 0xabc123] Error parsing Opus packet header.\n", True),
        (b"[libopus @ abc123] Error parsing Opus packet header.\n", True),
        (b"File ended prematurely\n", False),
        (
            b"[opus @ 0xabc123] Error parsing Opus packet header.\nLast message repeated 2 times\n",
            False,
        ),
        (b"Unknown encoder aac\n", False),
    ],
)
async def test_zero_exit_does_not_hide_media_errors_except_known_opus_probe(
    monkeypatch, diagnostic, accepted
):
    import stimulus_audio

    class Process:
        returncode = 0

        async def communicate(self):
            return b"packets", diagnostic

    async def create(*args, **kwargs):
        return Process()

    monkeypatch.setattr(stimulus_audio.asyncio, "create_subprocess_exec", create)
    if accepted:
        assert await stimulus_audio._run("ffprobe") == b"packets"
    else:
        with pytest.raises(RuntimeError):
            await stimulus_audio._run("ffprobe")
