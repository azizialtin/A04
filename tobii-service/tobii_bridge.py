"""WebSocket bridge between a Tobii eye tracker and the A04 frontend.

Runs on the lab machine. The browser connects to ws://localhost:8766, waits for
a `status` message, then sends `start_gaze` / `stop_gaze` to control streaming.
Every gaze frame is one JSON object:

    {"type": "gaze", "ts": <wall-clock ms>, "lx","ly","rx","ry": 0..1 | null,
     "lv","rv": bool, "dz": <eye distance mm | null>,
     "device_ts": <tracker microseconds>}

Calibration runs over the same socket, one target at a time:

    -> {"type": "calibrate_start"}
    <- {"type": "calibration_started"}
    -> {"type": "calibrate_point", "x": 0.1, "y": 0.1}     (display coordinates)
    <- {"type": "calibration_point_result", "x": .., "y": .., "ok": bool}
    -> {"type": "calibrate_compute"}
    <- {"type": "calibration_result", "ok": bool}
    -> {"type": "calibrate_abort"}                          (leaves the mode)

The screen capture behind the think-aloud replay runs from here too, so that it
shares the clock the gaze samples are stamped with:

    -> {"type": "start_screen_recording", "upload_url": .., "session_url": ..,
        "complete_url": .., "failed_url": .., "token": ..}
    <- {"type": "screen_recording_started", "ok": bool, "error": str|null}
    -> {"type": "stop_screen_recording"}
    <- {"type": "screen_recording_stopped", "ok": bool, "error": str|null}

Use --mock for synthetic data when no tracker (or no Tobii SDK) is around.
The real tracker needs the Tobii Pro SDK, which only runs on Python 3.10.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import errno
import json
import logging
import math
import os
import shutil
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import websockets

from gaze_source import TobiiSource
from connection_logging import install_incomplete_handshake_filter

from screen_recorder import (
    DEFAULT_CRF,
    DEFAULT_FPS,
    DEFAULT_MAX_HEIGHT,
    ScreenRecorder,
    report_failure,
    upload as upload_recording,
)

MOCK_HZ = 120
DEFAULT_PORT = 8766

# Where the study is served from. Anything else is refused, so a page the
# participant happens to have open cannot read their gaze. The deployed
# frontend is in here so the packaged bridge needs no arguments on a lab
# machine: a run there is one double-click, and a wrong origin looks exactly
# like a missing tracker.
DEFAULT_ORIGINS = (
    "https://a04.rdm.lab.lrz.de",
    "https://a04-frontend-356217033010.europe-west3.run.app",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
)


def app_dir() -> Path:
    """The folder the bridge was started from — the one a lab assistant sees.

    Packaged, that is where the .exe sits; from a checkout, the source folder.
    Not `__file__`: PyInstaller unpacks the code somewhere temporary, and a
    recording left behind there is a recording lost.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent


def use_bundled_tools() -> None:
    """Let ffmpeg ship next to the bridge instead of being installed.

    The recorder looks ffmpeg up on PATH, and asking a lab technician to edit
    PATH is the step that does not happen. If the binaries sit beside the
    bridge, that folder becomes part of PATH for this process alone.
    """
    here = app_dir()
    if (here / "ffmpeg.exe").exists() or (here / "ffmpeg").exists():
        os.environ["PATH"] = f"{here}{os.pathsep}{os.environ.get('PATH', '')}"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _frame(lx, ly, rx, ry, valid, device_ts, dz=None) -> str:
    return json.dumps(
        {
            "type": "gaze",
            "ts": _now_ms(),
            "lx": lx,
            "ly": ly,
            "rx": rx,
            "ry": ry,
            "lv": valid,
            "rv": valid,
            "dz": dz,
            "device_ts": device_ts,
        }
    )


class MockSource:
    """Synthetic gaze that drifts around the screen with an occasional blink."""

    connected = True
    source_mode = "mock"
    sdk_version = None
    model = "synthetic"
    display_area_mm = (530.0, 300.0)  # a 24" 16:9 panel, so the maths is exercised

    def __init__(self, frequency: int = MOCK_HZ) -> None:
        self.frequency = frequency

    async def calibration_start(self) -> bool:
        return True

    async def calibration_collect(self, x: float, y: float) -> bool:
        # Pretend the participant fixated; enough to exercise the whole screen.
        await asyncio.sleep(0.2)
        return 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0

    async def calibration_compute(self) -> bool:
        return True

    async def calibration_abort(self) -> None:
        return None

    async def stream(self, ws) -> None:
        period = 1.0 / self.frequency
        start = time.time()
        i = 0
        while True:
            t = time.time() - start
            blink = (i % (self.frequency * 5)) < 3  # ~3 samples every 5 s
            x = 0.5 + 0.3 * math.sin(t * 0.7)
            y = 0.5 + 0.3 * math.sin(t * 1.1 + 1.0)
            if blink:
                await ws.send(_frame(None, None, None, None, False, int(t * 1e6)))
            else:
                await ws.send(
                    _frame(round(x, 4), round(y, 4), round(x, 4), round(y, 4), True, int(t * 1e6), 620.0)
                )
            i += 1
            await asyncio.sleep(period)

    async def refresh(self) -> None:
        pass

    async def close(self) -> None:
        pass


def build_source(mock: bool):
    return MockSource() if mock else TobiiSource()


@dataclass
class Destination:
    """Where a finished capture goes, and what proves it may go there.

    `session_url` and `complete_url` are the direct-to-bucket path: the backend
    hands back somewhere in its bucket to PUT the bytes, then confirms what
    landed. `upload_url` is the older route through the backend itself, used
    when there is no bucket — and when the page that started this is an older
    build that never sent the other two.
    """

    upload_url: str = ""
    failed_url: str = ""
    session_url: str = ""
    complete_url: str = ""
    token: str = ""


class ScreenSession:
    """The one screen capture this machine can have running, and where its file
    goes when it stops.

    Held per-process rather than per-connection because there is only one
    screen. The connection that started it owns it, so a browser that navigates
    away or crashes does not leave ffmpeg recording an empty room.
    """

    def __init__(self, options: dict, keep_dir: Path) -> None:
        self.options = options
        self.keep_dir = keep_dir
        self.enabled = not options.pop("disabled", False)
        self.recorder: ScreenRecorder | None = None
        self.owner = None
        self.destination = Destination()
        self.uploads: set[asyncio.Task] = set()
        self._starting = False
        self._stopping = False

    @property
    def available(self) -> bool:
        return self.enabled and shutil.which("ffmpeg") is not None

    @property
    def audio_available(self) -> bool:
        return self.available and shutil.which("ffprobe") is not None

    def audio_message(self, ws, kind: str, msg: dict | bytes) -> str | None:
        if self.recorder is None or self.owner is not ws:
            return "Only the browser recording this screen may send stimulus audio."
        audio = self.recorder.audio
        if audio is None:
            return "Stimulus audio is unavailable for this capture."
        if not self.audio_available:
            return audio.fail("ffprobe is missing; install the updated Windows bridge package.")
        if kind == "chunk" and isinstance(msg, bytes):
            return audio.append(msg)
        if isinstance(msg, dict):
            if kind == "start_stimulus_audio":
                return audio.start(msg)
            if kind == "finish_stimulus_audio":
                return audio.finish(msg)
        return audio.fail("Invalid stimulus audio message.")

    async def start(self, ws, msg: dict) -> tuple[bool, str | None]:
        if not self.available:
            return False, "screen recording is not available on this machine"
        if self.recorder is not None:
            return False, "a screen recording is already running"
        destination = Destination(
            upload_url=str(msg.get("upload_url") or ""),
            failed_url=str(msg.get("failed_url") or ""),
            session_url=str(msg.get("session_url") or ""),
            complete_url=str(msg.get("complete_url") or ""),
            token=str(msg.get("token") or ""),
        )
        if not destination.upload_url or not destination.token:
            return False, "upload_url and token are required"

        recorder = ScreenRecorder(**self.options)
        # Reserve before awaiting FFmpeg: another socket can arrive meanwhile.
        self.recorder, self.owner = recorder, ws
        self.destination = destination
        self._starting = True
        try:
            await recorder.start()
        except asyncio.CancelledError:
            self.recorder, self.owner = None, None
            recorder.discard()
            raise
        except Exception as exc:
            # Anything at all — the study is not stopping because ffmpeg is not
            # happy, and this socket is also carrying the gaze stream.
            print(f"[bridge] screen recording did not start: {exc}")
            self.recorder, self.owner = None, None
            recorder.discard()
            return False, str(exc)
        finally:
            self._starting = False

        return True, None

    async def stop(self, ws) -> tuple[bool, str | None]:
        if self.recorder is None or (ws is not None and self.owner is not ws):
            return False, "no screen recording is running"
        if self._starting or self._stopping:
            return False, "the screen recorder is still starting or stopping"
        recorder = self.recorder
        destination = self.destination
        self._stopping = True
        error = None

        try:
            recording = await recorder.stop()
        except Exception as exc:
            print(f"[bridge] screen recording failed: {exc}")
            recorder.discard()
            error = str(exc)
        finally:
            self.recorder, self.owner = None, None
            self._stopping = False
        if error is not None:
            await self._report(destination, error)
            return False, error

        # The browser is already on the next screen; nothing is waiting for the
        # upload, so let it run on its own and keep the socket responsive.
        task = asyncio.create_task(self._deliver(recorder, recording, destination))
        self.uploads.add(task)
        task.add_done_callback(self.uploads.discard)
        return True, None

    async def _report(self, destination: Destination, error: str) -> None:
        if destination.failed_url and destination.token:
            await report_failure(destination.failed_url, destination.token, error)

    async def _deliver(self, recorder, recording, destination: Destination) -> None:
        try:
            if recorder.audio is not None:
                await recorder.audio.attach(recording)
            if recording.audio_status != "captured":
                detail = recording.audio_error or "no audible signal detected"
                print(f"[bridge] stimulus audio {recording.audio_status}: {detail}")
            await upload_recording(
                recording,
                destination.upload_url,
                destination.token,
                destination.session_url,
                destination.complete_url,
            )
            print(f"[bridge] uploaded {recording.duration_ms / 1000:.0f}s of screen recording")
            recorder.discard()
            return
        except Exception as exc:
            error = str(exc)

        # A session cannot be repeated, so a lost upload must leave the file
        # where a person can still find it.
        kept = self.keep_dir / f"screen-{recording.epoch_ms}-{uuid.uuid4().hex[:8]}.mp4"
        try:
            self.keep_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(recording.path), kept)
            recorder.discard()
            print(f"[bridge] upload failed ({error}); kept the recording at {kept}")
            error = f"{error} — the file is on the lab machine at {kept}"
        except Exception as exc:
            # The temporary file may be the only copy left. Do not delete it
            # merely because the configured recovery folder is unwritable.
            error = f"{error}; recovery failed ({exc}); original retained at {recording.path}"
            print(f"[bridge] {error}")
        await self._report(destination, error)

    async def release(self, ws) -> None:
        """Stop a capture whose owning connection has gone away."""
        if self.recorder is not None and self.owner is ws:
            print("[bridge] the recording browser disconnected; stopping the capture")
            await self.stop(ws)

    async def drain(self) -> None:
        if self.uploads:
            await asyncio.gather(*list(self.uploads), return_exceptions=True)


async def _handle_screen(ws, screen: ScreenSession, msg: dict) -> bool:
    """Returns True if the message was a screen-recording one."""
    kind = msg.get("type")
    if kind == "start_screen_recording":
        ok, error = await screen.start(ws, msg)
        await ws.send(json.dumps({"type": "screen_recording_started", "ok": ok, "error": error}))
    elif kind == "stop_screen_recording":
        ok, error = await screen.stop(ws)
        await ws.send(json.dumps({"type": "screen_recording_stopped", "ok": ok, "error": error}))
    elif kind in ("start_stimulus_audio", "finish_stimulus_audio"):
        error = screen.audio_message(ws, kind, msg)
        if error:
            await ws.send(json.dumps({"type": "stimulus_audio_error", "error": error}))
    else:
        return False
    return True


async def _handle_calibration(ws, source, msg: dict) -> bool:
    """Returns True if the message was a calibration one."""
    kind = msg.get("type")
    if kind == "calibrate_start":
        ok = await source.calibration_start()
        await ws.send(json.dumps({"type": "calibration_started", "ok": ok}))
    elif kind == "calibrate_point":
        x, y = float(msg.get("x", 0)), float(msg.get("y", 0))
        ok = await source.calibration_collect(x, y)
        await ws.send(json.dumps({"type": "calibration_point_result", "x": x, "y": y, "ok": ok}))
    elif kind == "calibrate_compute":
        ok = await source.calibration_compute()
        await ws.send(json.dumps({"type": "calibration_result", "ok": ok}))
    elif kind == "calibrate_abort":
        await source.calibration_abort()
        await ws.send(json.dumps({"type": "calibration_aborted"}))
    else:
        return False
    return True


async def _stream_gaze(source, ws):
    try:
        await source.stream(ws)
    except websockets.exceptions.ConnectionClosed:
        return
    except Exception as exc:
        print(f"[gaze] stream failed ({type(exc).__name__}); run Check-eye-tracker.cmd", flush=True)
        with contextlib.suppress(websockets.exceptions.ConnectionClosed):
            await ws.send(json.dumps({"type": "gaze_status", "state": "error",
                "source_mode": source.source_mode, "connected": source.connected,
                "subscribed": False, "error_code": "stream_failed",
                "error": f"Gaze streaming failed ({type(exc).__name__}). Run Check-eye-tracker.cmd."}))


async def _serve(
    port: int, host: str, mock: bool, allowed_origins: set[str], screen: ScreenSession
) -> None:
    # One tracker, shared. A source per connection meant a second tab fighting
    # the first for the subscription and for calibration mode.
    source = build_source(mock)
    discovery = asyncio.create_task(source.refresh())

    async def handler(ws) -> None:
        # websockets 12/13 expose request_headers; 14+ expose request.headers.
        headers = ws.request.headers if hasattr(ws, "request") else getattr(ws, "request_headers", {})
        origin = headers.get("Origin")
        if allowed_origins and origin not in allowed_origins:
            # A participant's live gaze is not for any page that asks.
            print(
                f"[bridge] refused a connection from origin {origin!r}; "
                "install the current A04Bridge package, or ask the study administrator "
                "to allow the exact study origin with --allow-origin."
            )
            await ws.close(code=4403, reason="origin not allowed")
            return

        async def send_status():
            area = source.display_area_mm
            await ws.send(
                json.dumps(
                    {
                        "type": "status",
                        "connected": source.connected,
                        "source_mode": source.source_mode,
                        "sdk_version": source.sdk_version,
                        "model": source.model,
                        "frequency": source.frequency,
                        "display_w_mm": area[0] if area else None,
                        "display_h_mm": area[1] if area else None,
                        # So the browser knows whether to expect a screen recording
                        # at all, rather than asking and reporting a failure.
                        "screen_recording": screen.available,
                        "stimulus_audio": screen.audio_available,
                    }
                )
            )

        await send_status()

        async def update_tracker_status():
            try:
                if discovery.done():
                    if not source.connected:
                        await source.refresh()
                else:
                    await asyncio.shield(discovery)
                await send_status()
                await ws.send(json.dumps(source.status()))
            except websockets.exceptions.ConnectionClosed:
                pass

        tracker_update = None if mock else asyncio.create_task(update_tracker_status())
        producer: asyncio.Task | None = None
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    error = screen.audio_message(ws, "chunk", raw)
                    if error:
                        await ws.send(json.dumps({"type": "stimulus_audio_error", "error": error}))
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if await _handle_calibration(ws, source, msg):
                    continue
                if await _handle_screen(ws, screen, msg):
                    continue
                kind = msg.get("type")
                if kind == "start_gaze" and (producer is None or producer.done()):
                    producer = asyncio.create_task(_stream_gaze(source, ws))
                elif kind == "stop_gaze":
                    if producer is not None:
                        producer.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await producer
                        producer = None
                    await ws.send(json.dumps({"type": "gaze_status", "state": "stopped",
                        "source_mode": source.source_mode, "connected": source.connected,
                        "subscribed": False, "sample_count": getattr(source, "sample_count", 0),
                        "valid_sample_count": getattr(source, "valid_sample_count", 0),
                        "frequency": source.frequency, "error": None, "error_code": None}))
        except websockets.exceptions.ConnectionClosed:
            # Navigation closes after enqueueing stop, before FFmpeg can reply.
            pass
        finally:
            # A stalled SDK must not hold the completed screen/audio capture.
            await screen.release(ws)
            if tracker_update is not None:
                tracker_update.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await tracker_update
            if producer is not None:
                producer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await producer
            await source.calibration_abort()

    try:
        logger = logging.getLogger("a04.bridge.websocket")
        install_incomplete_handshake_filter(logger)
        async with websockets.serve(handler, host, port, logger=logger):
            print(f"[bridge] listening on ws://{host}:{port} ({'mock' if mock else 'tobii'})")
            print(f"[bridge] accepting origins: {', '.join(sorted(allowed_origins)) or 'any'}")
            print("[bridge] Allow local-network access in the study browser. For a tracker-only check, close this window and run Check-eye-tracker.cmd.", flush=True)
            if screen.available:
                print("[bridge] screen recording enabled (ffmpeg found)")
            elif screen.enabled:
                print("[bridge] screen recording unavailable: ffmpeg is not on PATH")
            await asyncio.Future()  # run until interrupted
    finally:
        discovery.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await discovery
        await screen.release(screen.owner)
        await screen.drain()
        await source.close()


def wants_test_pattern(screen_source: str, mock: bool) -> bool:
    """Whether to capture ffmpeg's test pattern instead of the display.

    `auto` follows --mock, because a machine with no tracker is usually not the
    lab machine either. `display` is the override: on a laptop it is the only
    way to see the cursor and the pauses in a replay, which is the whole reason
    the capture exists, and mock gaze is the only gaze available there.
    """
    return screen_source == "test-pattern" or (screen_source == "auto" and mock)


def main() -> None:
    use_bundled_tools()
    ap = argparse.ArgumentParser(description="A04 Tobii → WebSocket bridge")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--check-sdk", action="store_true", help="verify the Tobii native SDK and exit")
    ap.add_argument("--diagnose", action="store_true", help="check real tracker samples and print a report without gaze coordinates")
    ap.add_argument("--diagnostic-seconds", type=float, default=8, help="hardware check duration, 2–30 seconds")
    # The browser is on this machine, so there is no reason to offer a
    # participant's live gaze to the rest of the network.
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default: loopback)")
    ap.add_argument("--mock", action="store_true", help="stream synthetic gaze")
    ap.add_argument(
        "--allow-origin",
        action="append",
        default=None,
        help="browser origin allowed to connect (repeatable; empty string allows any)",
    )
    ap.add_argument("--no-screen-recording", action="store_true", help="do not capture the screen")
    ap.add_argument(
        "--screen-source",
        choices=("auto", "display", "test-pattern"),
        default="auto",
        help="what to capture: the real display, a synthetic test pattern, or "
        "'auto' — the display, or the test pattern under --mock",
    )
    ap.add_argument(
        "--screen-device",
        default=None,
        help="capture device: gdigrab title (Windows), avfoundation index (macOS), display (X11)",
    )
    ap.add_argument("--screen-fps", type=int, default=DEFAULT_FPS)
    ap.add_argument("--screen-crf", type=int, default=DEFAULT_CRF, help="x264 quality, lower is bigger")
    ap.add_argument("--screen-max-height", type=int, default=DEFAULT_MAX_HEIGHT)
    ap.add_argument(
        "--screen-keep-dir",
        default=None,
        help="where to leave a recording the backend would not take (default: ./unsent-recordings)",
    )
    args = ap.parse_args()
    if args.diagnose:
        if args.mock or not 2 <= args.diagnostic_seconds <= 30:
            ap.error("--diagnose requires a real tracker and --diagnostic-seconds between 2 and 30")
        from tracker_diagnostics import diagnose_tracker

        report = asyncio.run(diagnose_tracker(args.diagnostic_seconds))
        print(json.dumps(report, indent=2), flush=True)
        raise SystemExit(0 if report["ok"] else 1)
    if args.check_sdk:
        import tobii_research as tr

        print(json.dumps({
            "sdk_version": tr.__version__, "trackers": len(tr.find_all_eyetrackers()),
        }))
        return
    origins = set(args.allow_origin) if args.allow_origin is not None else set(DEFAULT_ORIGINS)
    origins.discard("")

    screen = ScreenSession(
        {
            "disabled": args.no_screen_recording,
            "fps": args.screen_fps,
            "crf": args.screen_crf,
            "max_height": args.screen_max_height,
            "device": args.screen_device,
            "test_pattern": wants_test_pattern(args.screen_source, args.mock),
        },
        Path(args.screen_keep_dir) if args.screen_keep_dir else app_dir() / "unsent-recordings",
    )
    try:
        asyncio.run(_serve(args.port, args.host, args.mock, origins, screen))
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        # Almost always a second bridge already running: the traceback for that
        # is long and says nothing a lab assistant can act on.
        if exc.errno in (errno.EADDRINUSE, errno.EACCES):
            _fatal(
                f"port {args.port} is already in use — the bridge is probably "
                "already running. Close the other window and start it again."
            )
        _fatal(str(exc))


def _fatal(message: str) -> None:
    """Report and stop — visibly, when there is nobody watching a terminal.

    Double-clicked, the console window dies with the process, so an error that
    only prints is an error nobody ever sees.
    """
    print(f"[bridge] {message}")
    if getattr(sys, "frozen", False):
        input("Press Enter to close this window.")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
