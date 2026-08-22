"""Full-screen capture for the think-aloud replay.

The tracker reports gaze against the whole display, so a full-screen recording
is the one surface a sample lands on with nothing to undo — no window position,
no browser chrome, no letterbox. ffmpeg draws the cursor into the frames, so
the participant's mouse is part of the record too.

Which display that is has to be named, not assumed. Windows and X11 name theirs;
macOS numbers cameras and screens in a single list, so the screen's index moves
with whatever else is attached, and a stale guess records a webcam without ever
reporting an error.

The clock is why this lives in the bridge rather than in the browser. Gaze
samples are stamped with this machine's `time.time()`, and so is the anchor
below: ffmpeg's `-progress` stream says how far into the output it is, so the
wall time of video position zero is `now - out_time`. Encoding only ever runs
*behind* the capture, never ahead, so the smallest difference we observe is the
best estimate of the start — hence the running minimum rather than one reading.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import platform
import re
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_FPS = 30
# Screen content is flat and text-heavy; this stays sharp and keeps a ten-minute
# case near 150 MB rather than a gigabyte.
DEFAULT_CRF = 28
DEFAULT_MAX_HEIGHT = 1080

# `+faststart` rewrites the moov atom when ffmpeg exits, which takes a moment on
# a long recording. Killing it instead leaves an mp4 nothing can play.
STOP_TIMEOUT_S = 30.0
FIRST_FRAME_TIMEOUT_S = 8.0

UPLOAD_ATTEMPTS = 3
UPLOAD_BACKOFF_S = 3.0
# Sent to a resumable session one chunk at a time. GCS requires a multiple of
# 256 KiB for every chunk but the last.
RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024

DEVICE_PROBE_TIMEOUT_S = 10.0
# avfoundation numbers every video device in one list, cameras first: a Mac with
# a built-in camera, a Continuity camera and two Desk View entries puts the
# display at 4. There is no index that is right on every machine.
MACOS_SCREEN_LINE = re.compile(r"\[(\d+)\]\s+Capture screen", re.IGNORECASE)


class ScreenRecordingError(RuntimeError):
    """Capture could not start, or ended in a state we will not vouch for."""


@dataclass
class Recording:
    path: Path
    epoch_ms: int  # wall-clock ms at video position 0
    duration_ms: int
    width: int | None = None
    height: int | None = None
    fps: float = DEFAULT_FPS


@dataclass
class _Progress:
    anchor_ms: float | None = None
    duration_ms: int = 0
    stderr: list[str] = field(default_factory=list)


def _capture_input(fps: int, device: str | None, test_pattern: bool) -> list[str]:
    """The platform's screen grabber. `-framerate` has to precede `-i` for all
    of them — it configures the device, not the encoder."""
    if test_pattern:
        # Exercises the whole path (anchor, upload, replay) on a machine with no
        # screen-recording permission and no tracker. `-re` keeps it real-time so
        # the clock anchor means the same thing it will in the lab.
        return ["-re", "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate={fps}"]

    system = platform.system()
    if system == "Windows":
        return ["-f", "gdigrab", "-draw_mouse", "1", "-framerate", str(fps), "-i", device or "desktop"]
    if system == "Darwin":
        # No default: the index differs per machine, so `start()` probes for it
        # and refuses to record rather than guess. See `macos_screen_device`.
        return [
            "-f", "avfoundation", "-capture_cursor", "1", "-capture_mouse_clicks", "1",
            "-framerate", str(fps), "-i", device or "",
        ]
    return ["-f", "x11grab", "-draw_mouse", "1", "-framerate", str(fps), "-i", device or ":0.0"]


def _no_frames_hint() -> str:
    """Why a capture that started cleanly never produced a frame.

    On macOS an ungranted Screen Recording permission does not fail — ffmpeg
    waits on a consent prompt that never appears for a process nobody is looking
    at, and the stderr tail is a list of pixel formats that explains nothing.
    """
    if platform.system() == "Darwin":
        return (
            " (grant Screen Recording to the terminal running the bridge: System "
            "Settings › Privacy & Security › Screen Recording, then restart it)"
        )
    return ""


async def macos_screen_device(timeout_s: float = DEVICE_PROBE_TIMEOUT_S) -> str | None:
    """avfoundation's index for the first screen, as `"<n>:none"`.

    Worth a subprocess because the alternative is guessing, and a wrong guess
    here does not fail — it records whatever device holds that index, which on
    most Macs is a camera pointed at the participant. Nobody consented to that.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
    except OSError:
        return None
    try:
        # Listing always exits non-zero — there is no input to open — so the
        # device list arrives on stderr and the return code says nothing.
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout_s)
    except Exception:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        return None
    return parse_macos_screen_device(stderr.decode(errors="replace"))


def parse_macos_screen_device(listing: str) -> str | None:
    """Pick the first screen out of `-list_devices` output. Audio devices are
    numbered from zero again, so the video section is where to look."""
    in_video = False
    for line in listing.splitlines():
        if "video devices" in line:
            in_video = True
            continue
        if "audio devices" in line:
            break
        if not in_video:
            continue
        match = MACOS_SCREEN_LINE.search(line)
        if match:
            return f"{match.group(1)}:none"
    return None


def _ffmpeg_command(
    out: Path, fps: int, crf: int, max_height: int, device: str | None, test_pattern: bool
) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        *_capture_input(fps, device, test_pattern),
        # Never upscale a smaller display; 1080 is even, so the -2 width stays
        # even too and yuv420p is happy.
        "-vf", f"scale=-2:'min({max_height},ih)'",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-y",
        str(out),
    ]


async def _probe_size(path: Path) -> tuple[int | None, int | None]:
    """Frame size, for the admin listing. Best-effort: the mapping does not need
    it, since gaze is normalised to the frame either way."""
    if shutil.which("ffprobe") is None:
        return None, None
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), 10)
        stream = json.loads(stdout)["streams"][0]
        return int(stream["width"]), int(stream["height"])
    except Exception:
        return None, None


class ScreenRecorder:
    """One ffmpeg capture of the whole display, start to finish."""

    def __init__(
        self,
        fps: int = DEFAULT_FPS,
        crf: int = DEFAULT_CRF,
        max_height: int = DEFAULT_MAX_HEIGHT,
        device: str | None = None,
        test_pattern: bool = False,
    ) -> None:
        self.fps = fps
        self.crf = crf
        self.max_height = max_height
        self.device = device
        self.test_pattern = test_pattern
        self._proc: asyncio.subprocess.Process | None = None
        self._progress = _Progress()
        self._tasks: list[asyncio.Task] = []
        self._dir: Path | None = None
        self._path: Path | None = None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self) -> None:
        if shutil.which("ffmpeg") is None:
            raise ScreenRecordingError("ffmpeg is not on PATH")
        if self.running:
            raise ScreenRecordingError("a recording is already running")
        await self._resolve_device()

        self._dir = Path(tempfile.mkdtemp(prefix="a04-screen-"))
        self._path = self._dir / "screen.mp4"
        self._progress = _Progress()

        self._proc = await asyncio.create_subprocess_exec(
            *_ffmpeg_command(
                self._path, self.fps, self.crf, self.max_height, self.device, self.test_pattern
            ),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._tasks = [
            asyncio.create_task(self._read_progress()),
            asyncio.create_task(self._read_stderr()),
        ]

        # Block until frames are actually coming out. A wrong capture device or
        # a refused screen-recording permission fails here, while the browser is
        # still listening — not ten minutes later with an empty file.
        try:
            await asyncio.wait_for(self._await_anchor(), FIRST_FRAME_TIMEOUT_S)
        except asyncio.TimeoutError:
            await self._abort()
            raise ScreenRecordingError(
                f"ffmpeg produced no frames in {FIRST_FRAME_TIMEOUT_S:.0f}s"
                f"{_no_frames_hint()}: {self._stderr_tail()}"
            ) from None

    async def _resolve_device(self) -> None:
        """Fill in the capture device on the one platform that cannot be guessed.

        Windows and X11 name their displays; macOS numbers all video devices in
        one list with cameras first, so the screen's index depends on what else
        is plugged in. Failing here is the point — an unresolved index would
        otherwise record a camera, and it would look like it worked.
        """
        if self.test_pattern or self.device or platform.system() != "Darwin":
            return
        self.device = await macos_screen_device()
        if self.device is None:
            raise ScreenRecordingError(
                "could not find avfoundation's screen index — run "
                '`ffmpeg -f avfoundation -list_devices true -i ""` and pass the '
                '"Capture screen" number as --screen-device "<n>:none". Not guessing: '
                "the wrong index records a camera."
            )
        print(f"[bridge] capturing avfoundation device {self.device}")

    async def _await_anchor(self) -> None:
        while True:
            if self._progress.anchor_ms is not None:
                return
            if self._proc is not None and self._proc.returncode is not None:
                raise ScreenRecordingError(f"ffmpeg exited immediately: {self._stderr_tail()}")
            await asyncio.sleep(0.05)

    async def _read_progress(self) -> None:
        # Bound once: `stop()` clears self._proc while this is still draining
        # the last of the stream.
        assert self._proc is not None and self._proc.stdout is not None
        stream = self._proc.stdout
        while True:
            line = await stream.readline()
            if not line:
                return
            key, _, value = line.decode(errors="replace").strip().partition("=")
            # `out_time_ms` is microseconds too — a misnomer ffmpeg has never
            # corrected. Either key answers the same question.
            if key not in ("out_time_us", "out_time_ms"):
                continue
            try:
                out_time_us = int(value)
            except ValueError:
                continue  # "N/A" before the first frame
            if out_time_us <= 0:
                continue
            observed = time.time() * 1000 - out_time_us / 1000
            anchor = self._progress.anchor_ms
            self._progress.anchor_ms = observed if anchor is None else min(anchor, observed)
            self._progress.duration_ms = max(self._progress.duration_ms, out_time_us // 1000)

    async def _read_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        stream = self._proc.stderr
        while True:
            line = await stream.readline()
            if not line:
                return
            text = line.decode(errors="replace").strip()
            if text:
                # Keep the tail only; a stuck capture can be very chatty.
                self._progress.stderr = [*self._progress.stderr[-19:], text]

    def _stderr_tail(self) -> str:
        return " | ".join(self._progress.stderr[-3:]) or "no output"

    async def _abort(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
        await self._settle()
        self.discard()

    async def _settle(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []

    async def stop(self) -> Recording:
        proc, self._proc = self._proc, None
        if proc is None:
            raise ScreenRecordingError("no recording is running")

        # `q` on stdin is a graceful stop: ffmpeg flushes the encoder and moves
        # the moov atom to the front. SIGKILL skips both and the file is scrap.
        if proc.stdin is not None and proc.returncode is None:
            with contextlib.suppress(BrokenPipeError, ConnectionResetError, OSError):
                proc.stdin.write(b"q")
                await proc.stdin.drain()
                proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), STOP_TIMEOUT_S)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            await self._settle()
            self.discard()
            raise ScreenRecordingError("ffmpeg would not shut down; the recording is unusable")

        await self._settle()
        path, progress = self._path, self._progress
        if proc.returncode not in (0, 255):  # 255 is ffmpeg's own "quit requested"
            self.discard()
            raise ScreenRecordingError(f"ffmpeg exited {proc.returncode}: {self._stderr_tail()}")
        if path is None or not path.is_file() or path.stat().st_size == 0:
            self.discard()
            raise ScreenRecordingError("ffmpeg wrote no file")
        if progress.anchor_ms is None:
            self.discard()
            raise ScreenRecordingError("never established a clock anchor; gaze could not be aligned")

        width, height = await _probe_size(path)
        return Recording(
            path=path,
            epoch_ms=int(round(progress.anchor_ms)),
            duration_ms=progress.duration_ms,
            width=width,
            height=height,
            fps=float(self.fps),
        )

    def discard(self) -> None:
        """Drop the temp directory. Safe to call more than once."""
        folder, self._dir = self._dir, None
        self._path = None
        if folder is not None:
            shutil.rmtree(folder, ignore_errors=True)


def _metadata(recording: Recording) -> dict[str, str]:
    metadata = {
        "epoch_ms": str(recording.epoch_ms),
        "duration_ms": str(recording.duration_ms),
        "fps": str(recording.fps),
    }
    if recording.width and recording.height:
        metadata["width"] = str(recording.width)
        metadata["height"] = str(recording.height)
    return metadata


def _committed(response, fallback: int) -> int:
    """How far GCS says it got, from the Range it answers an unfinished PUT with.

    The header is `bytes=0-<last byte stored>`, so the next chunk starts one
    past it. Anything unparseable falls back to what we believe we sent.
    """
    header = response.headers.get("Range", "")
    if header.startswith("bytes=0-"):
        try:
            return int(header.split("-", 1)[1]) + 1
        except ValueError:
            pass
    return fallback


async def _session_offset(client, session_url: str, total: int) -> int:
    """Ask the session how much of the file it already holds.

    Asked only when a chunk failed, so a retry resumes rather than starting a
    two hundred megabyte upload over.
    """
    response = await client.put(
        session_url, headers={"Content-Range": f"bytes */{total}"}, content=b""
    )
    if response.status_code in (200, 201):
        return total
    if response.status_code == 308:
        return _committed(response, 0)
    raise ScreenRecordingError(
        f"the bucket would not resume: {response.status_code} {response.text[:200]}"
    )


async def _put_to_bucket(client, session_url: str, path: Path) -> None:
    """Send the file to a resumable session, a chunk at a time.

    Chunked rather than one PUT so a dropped connection costs one chunk instead
    of the whole capture — which is the difference between a retry and a lost
    session.
    """
    total = path.stat().st_size
    if total == 0:
        raise ScreenRecordingError("the capture is empty")

    offset = 0
    attempt = 1
    with path.open("rb") as handle:
        while offset < total:
            handle.seek(offset)
            chunk = handle.read(RESUMABLE_CHUNK_BYTES)
            end = offset + len(chunk) - 1
            try:
                response = await client.put(
                    session_url,
                    content=chunk,
                    headers={"Content-Range": f"bytes {offset}-{end}/{total}"},
                )
            except Exception:
                if attempt >= UPLOAD_ATTEMPTS:
                    raise
                await asyncio.sleep(UPLOAD_BACKOFF_S * attempt)
                attempt += 1
                offset = await _session_offset(client, session_url, total)
                continue

            if response.status_code in (200, 201):
                return
            if response.status_code == 308:
                offset = _committed(response, offset + len(chunk))
                attempt = 1
                continue
            raise ScreenRecordingError(
                f"the bucket said {response.status_code}: {response.text[:200]}"
            )


async def upload(
    recording: Recording,
    url: str,
    token: str,
    session_url: str = "",
    complete_url: str = "",
) -> None:
    """Deliver the finished capture, retrying a few times.

    Where the backend has a bucket it hands back a resumable session and the
    bytes go straight there — a hosted backend will not carry a body this size,
    and a capture is hundreds of megabytes. Without one the file is posted to
    the backend as before, which is also the path taken when the page that
    started this predates the session endpoints.

    The browser has already moved on by the time this runs, so nothing on screen
    is waiting for it — but a session cannot be repeated, so a failure here has
    to leave the file somewhere a person can find it.
    """
    import httpx

    if session_url and complete_url:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)) as client:
            asked = await client.post(
                session_url,
                headers={"Authorization": f"Bearer {token}"},
                json={"size_bytes": recording.path.stat().st_size, "content_type": "video/mp4"},
            )
            if asked.status_code >= 300:
                raise ScreenRecordingError(
                    f"backend would not open an upload: {asked.status_code}: {asked.text[:200]}"
                )
            opened = asked.json()
            if opened.get("mode") == "resumable" and opened.get("upload_url"):
                await _put_to_bucket(client, opened["upload_url"], recording.path)
                done = await client.post(
                    complete_url,
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "epoch_ms": recording.epoch_ms,
                        "duration_ms": recording.duration_ms,
                        "width": recording.width,
                        "height": recording.height,
                        "fps": recording.fps,
                    },
                )
                if done.status_code >= 300:
                    raise ScreenRecordingError(
                        f"backend would not accept the upload: "
                        f"{done.status_code}: {done.text[:200]}"
                    )
                return
            # mode == "proxy": this deployment stores files itself.

    metadata = _metadata(recording)

    last: Exception | None = None
    for attempt in range(1, UPLOAD_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)) as client:
                with recording.path.open("rb") as handle:
                    response = await client.post(
                        url,
                        headers={"Authorization": f"Bearer {token}"},
                        data=metadata,
                        files={"file": ("screen.mp4", handle, "video/mp4")},
                    )
            if response.status_code < 300:
                return
            last = ScreenRecordingError(f"backend said {response.status_code}: {response.text[:200]}")
            # A rejected upload will be rejected again; only retry transient ones.
            if response.status_code < 500:
                break
        except Exception as exc:
            last = exc
        if attempt < UPLOAD_ATTEMPTS:
            await asyncio.sleep(UPLOAD_BACKOFF_S * attempt)

    raise ScreenRecordingError(f"could not upload the screen recording: {last}")


async def report_failure(url: str, token: str, error: str) -> None:
    """Tell the backend the capture came to nothing.

    The failures worth reporting happen at the end — ffmpeg refusing to shut
    down, an upload the backend will not take — and by then the browser has
    moved on. Without this the row sits at "recording" forever and looks like a
    capture still in progress.
    """
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.patch(
                url, headers={"Authorization": f"Bearer {token}"}, json={"error": error[:500]}
            )
    except Exception as exc:
        print(f"[bridge] could not report the failure ({exc}): {error}")
