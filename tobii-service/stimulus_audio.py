"""Receive the case video's live soundtrack and join it to the screen capture."""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from screen_recorder import Recording

MAX_CHUNK_BYTES = 64 * 1024
MAX_AUDIO_BYTES = 256 * 1024 * 1024
AUDIO_STATUSES = {"captured", "silent", "failed", "unavailable"}
MIME_EXTENSIONS = {"audio/webm": ".webm", "audio/mp4": ".m4a", "audio/ogg": ".ogg"}
OPUS_PROBE_DIAGNOSTIC = re.compile(
    r"\[(?:lib)?opus @ (?:0x)?[0-9a-fA-F]+\] Error parsing Opus packet header\."
)


async def _run(*args: str, timeout: float = 30) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except BaseException:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        raise
    # Some FFmpeg builds print this single probe diagnostic even for their own
    # complete Opus output. Other errors, including premature EOF, are fatal
    # even when the demuxer returns zero.
    diagnostics = stderr.decode(errors="replace").strip().splitlines()
    benign_probe = len(diagnostics) == 1 and OPUS_PROBE_DIAGNOSTIC.fullmatch(diagnostics[0])
    if proc.returncode or (diagnostics and not benign_probe):
        raise RuntimeError(stderr.decode(errors="replace")[-500:] or f"{args[0]} failed")
    return stdout


async def has_audio_packets(path: Path) -> bool:
    result = await _run(
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-count_packets",
        "-show_entries",
        "stream=codec_name,nb_read_packets",
        "-of",
        "json",
        str(path),
    )
    streams = json.loads(result).get("streams", [])
    return bool(streams and int(streams[0].get("nb_read_packets", 0)) > 0)


async def video_duration(path: Path) -> float:
    result = await _run(
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "json",
        str(path),
    )
    streams = json.loads(result).get("streams", [])
    seconds = float(streams[0]["duration"])
    if not math.isfinite(seconds) or seconds <= 0:
        raise RuntimeError("The screen file has no valid video duration.")
    return seconds


class StimulusAudio:
    """One ordered MediaRecorder stream, owned by the screen's socket."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.path: Path | None = None
        self.epoch_ms: int | None = None
        self.size = 0
        self.finished = False
        self.status = "unavailable"
        self.error: str | None = "The browser did not supply stimulus audio."

    def fail(self, message: str) -> str:
        self.status = "failed"
        self.error = message[:500]
        return self.error

    def start(self, msg: dict) -> str | None:
        if self.path is not None or self.finished:
            return self.fail("Stimulus audio was started more than once.")
        mime = str(msg.get("mime_type", "")).split(";", 1)[0].lower()
        epoch = msg.get("epoch_ms")
        if mime not in MIME_EXTENSIONS:
            return self.fail("Unsupported stimulus audio format.")
        if (
            isinstance(epoch, bool)
            or not isinstance(epoch, (int, float))
            or (isinstance(epoch, float) and not math.isfinite(epoch))
            or abs(epoch - int(time.time() * 1000)) > 60_000
        ):
            return self.fail("Invalid stimulus audio clock anchor.")
        self.epoch_ms = int(epoch)
        self.path = self.folder / ("stimulus" + MIME_EXTENSIONS[mime])
        try:
            self.path.write_bytes(b"")
        except OSError as exc:
            return self.fail(f"Could not create stimulus audio file: {exc}")
        self.status = "unknown"
        self.error = None
        return None

    def append(self, chunk: bytes) -> str | None:
        if self.status == "failed":
            return self.error
        if self.path is None or self.finished:
            return self.fail("Stimulus audio arrived outside an active audio capture.")
        if len(chunk) > MAX_CHUNK_BYTES or self.size + len(chunk) > MAX_AUDIO_BYTES:
            return self.fail("Stimulus audio exceeded its transfer limit.")
        try:
            with self.path.open("ab") as handle:
                handle.write(chunk)
        except OSError as exc:
            return self.fail(f"Could not store stimulus audio: {exc}")
        self.size += len(chunk)
        return None

    def finish(self, msg: dict) -> str | None:
        if self.finished:
            return self.fail("Stimulus audio was finalized more than once.")
        self.finished = True
        if self.status == "failed":
            return self.error
        status = msg.get("audio_status")
        if not isinstance(status, str) or status not in AUDIO_STATUSES:
            return self.fail("The browser did not report a valid audio capture result.")
        self.status = status
        self.error = str(msg.get("audio_error") or "")[:500] or None
        if status in {"captured", "silent"} and (self.path is None or not self.size):
            return self.fail("The browser reported audio but supplied no audio bytes.")
        return None

    async def attach(self, recording: Recording) -> None:
        """Copy the video unchanged; align only the live audio's clock."""
        if self.path is not None and not self.finished:
            self.fail("Stimulus audio ended before its final chunk was confirmed.")
        if self.status in {"captured", "silent"}:
            try:
                assert self.path is not None and self.epoch_ms is not None
                if recording.duration_ms <= 0:
                    raise RuntimeError("The screen recording has no measured duration.")
                if not await has_audio_packets(self.path):
                    raise RuntimeError("The stimulus file contains no encoded audio packets.")
                # Encoder progress can trail the final B-frames. Keep the stored
                # metadata but do not trim speech off those final video frames.
                duration = await video_duration(recording.path)
                offset = self.epoch_ms - recording.epoch_ms
                if offset >= duration * 1000:
                    raise RuntimeError("The stimulus audio starts after the screen recording ends.")
                filters = ["asetpts=PTS-STARTPTS"]
                if offset < 0:
                    filters = [f"atrim=start={-offset / 1000:.6f}", *filters]
                elif offset > 0:
                    filters.append(f"adelay={offset}:all=1")
                filters.extend(["apad", f"atrim=duration={duration:.6f}"])
                output = self.folder / "screen-with-audio.mp4"
                await _run(
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(recording.path),
                    "-i",
                    str(self.path),
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "copy",
                    "-af",
                    ",".join(filters),
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-movflags",
                    "+faststart",
                    str(output),
                    timeout=180,
                )
                if not await has_audio_packets(output):
                    raise RuntimeError("The combined recording contains no audio packets.")
                output.replace(recording.path)
            except Exception as exc:
                self.fail(f"Stimulus audio could not be joined to the recording: {exc}")
        recording.audio_status = self.status
        recording.audio_error = self.error
