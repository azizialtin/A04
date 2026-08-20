"""WebSocket bridge between a Tobii eye tracker and the A04 frontend.

Runs on the lab machine. The browser connects to ws://localhost:8765, waits for
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

    -> {"type": "start_screen_recording", "upload_url": .., "token": ..}
    <- {"type": "screen_recording_started", "ok": bool, "error": str|null}
    -> {"type": "stop_screen_recording"}
    <- {"type": "screen_recording_stopped", "ok": bool, "error": str|null}

Use --mock for synthetic data when no tracker (or no Tobii SDK) is around.
The real tracker needs the Tobii Pro SDK, which only runs on Python 3.10.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import shutil
import time
from pathlib import Path

import websockets

from screen_recorder import (
    DEFAULT_CRF,
    DEFAULT_FPS,
    DEFAULT_MAX_HEIGHT,
    ScreenRecorder,
    report_failure,
    upload as upload_recording,
)

MOCK_HZ = 120

# Where the study is served from. Anything else is refused, so a page the
# participant happens to have open cannot read their gaze.
DEFAULT_ORIGINS = ("http://localhost:5175", "http://127.0.0.1:5175")


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

    def close(self) -> None:
        pass


def _eye_distance_mm(g) -> float | None:
    """Eye-to-tracker distance, averaged over whichever eyes are being tracked.
    The validation step needs it to express an offset in degrees."""
    distances = []
    for side in ("left", "right"):
        if g.get(f"{side}_gaze_origin_validity") != 1:
            continue
        origin = g.get(f"{side}_gaze_origin_in_user_coordinate_system")
        if origin and len(origin) == 3 and not math.isnan(origin[2]):
            distances.append(float(origin[2]))
    return round(sum(distances) / len(distances), 1) if distances else None


class TobiiSource:
    """A real Tobii Pro tracker via the vendor SDK (Python 3.10 only)."""

    def __init__(self) -> None:
        import tobii_research as tr

        self._tr = tr
        trackers = tr.find_all_eyetrackers()
        self._tracker = trackers[0] if trackers else None
        self.connected = self._tracker is not None
        self.frequency = int(self._tracker.get_gaze_output_frequency()) if self._tracker else 0
        self._calibration = None

    @property
    def display_area_mm(self) -> tuple[float, float] | None:
        """Physical screen size, which is what turns a gaze offset into degrees."""
        if not self._tracker:
            return None
        try:
            area = self._tracker.get_display_area()
            return (float(area.width), float(area.height))
        except Exception:
            return None

    # The SDK's calibration calls block; keep them off the event loop.

    async def calibration_start(self) -> bool:
        if not self._tracker:
            return False
        self._calibration = self._tr.ScreenBasedCalibration(self._tracker)
        await asyncio.to_thread(self._calibration.enter_calibration_mode)
        return True

    async def calibration_collect(self, x: float, y: float) -> bool:
        if self._calibration is None:
            return False
        status = await asyncio.to_thread(self._calibration.collect_data, x, y)
        return status == self._tr.CALIBRATION_STATUS_SUCCESS

    async def calibration_compute(self) -> bool:
        if self._calibration is None:
            return False
        result = await asyncio.to_thread(self._calibration.compute_and_apply)
        await self.calibration_abort()
        return result.status == self._tr.CALIBRATION_STATUS_SUCCESS

    async def calibration_abort(self) -> None:
        if self._calibration is None:
            return
        calibration, self._calibration = self._calibration, None
        try:
            await asyncio.to_thread(calibration.leave_calibration_mode)
        except Exception:
            pass

    async def stream(self, ws) -> None:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str] = asyncio.Queue()

        def on_gaze(g) -> None:
            lv = g["left_gaze_point_validity"] == 1
            rv = g["right_gaze_point_validity"] == 1
            lx, ly = g["left_gaze_point_on_display_area"]
            rx, ry = g["right_gaze_point_on_display_area"]
            frame = json.dumps(
                {
                    "type": "gaze",
                    "ts": _now_ms(),
                    "lx": lx if lv else None,
                    "ly": ly if lv else None,
                    "rx": rx if rv else None,
                    "ry": ry if rv else None,
                    "lv": lv,
                    "rv": rv,
                    "dz": _eye_distance_mm(g),
                    "device_ts": g.get("device_time_stamp"),
                }
            )
            # The SDK calls us on its own thread; hop back onto the loop.
            loop.call_soon_threadsafe(queue.put_nowait, frame)

        self._tracker.subscribe_to(self._tr.EYETRACKER_GAZE_DATA, on_gaze, as_dictionary=True)
        self._on_gaze = on_gaze
        try:
            while True:
                await ws.send(await queue.get())
        finally:
            self._tracker.unsubscribe_from(self._tr.EYETRACKER_GAZE_DATA, on_gaze)

    def close(self) -> None:
        pass


def build_source(mock: bool):
    if mock:
        return MockSource()
    try:
        return TobiiSource()
    except Exception as exc:  # SDK missing, wrong Python, no tracker
        print(f"[bridge] no real tracker ({exc}); pass --mock for synthetic data")

        class _Absent:
            connected = False
            frequency = 0
            display_area_mm = None

            async def stream(self, ws):
                return

            async def calibration_start(self):
                return False

            async def calibration_collect(self, x, y):
                return False

            async def calibration_compute(self):
                return False

            async def calibration_abort(self):
                return None

            def close(self):
                pass

        return _Absent()


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
        self.upload_url = ""
        self.failed_url = ""
        self.token = ""
        self.uploads: set[asyncio.Task] = set()

    @property
    def available(self) -> bool:
        return self.enabled and shutil.which("ffmpeg") is not None

    async def start(self, ws, msg: dict) -> tuple[bool, str | None]:
        if not self.available:
            return False, "screen recording is not available on this machine"
        if self.recorder is not None:
            return False, "a screen recording is already running"
        upload_url = str(msg.get("upload_url") or "")
        failed_url = str(msg.get("failed_url") or "")
        token = str(msg.get("token") or "")
        if not upload_url or not token:
            return False, "upload_url and token are required"

        recorder = ScreenRecorder(**self.options)
        try:
            await recorder.start()
        except Exception as exc:
            # Anything at all — the study is not stopping because ffmpeg is not
            # happy, and this socket is also carrying the gaze stream.
            print(f"[bridge] screen recording did not start: {exc}")
            recorder.discard()
            return False, str(exc)

        self.recorder, self.owner = recorder, ws
        self.upload_url, self.failed_url, self.token = upload_url, failed_url, token
        return True, None

    async def stop(self, ws) -> tuple[bool, str | None]:
        if self.recorder is None or (ws is not None and self.owner is not ws):
            return False, "no screen recording is running"
        recorder, self.recorder, self.owner = self.recorder, None, None
        upload_url, failed_url, token = self.upload_url, self.failed_url, self.token

        try:
            recording = await recorder.stop()
        except Exception as exc:
            print(f"[bridge] screen recording failed: {exc}")
            recorder.discard()
            await self._report(failed_url, token, str(exc))
            return False, str(exc)

        # The browser is already on the next screen; nothing is waiting for the
        # upload, so let it run on its own and keep the socket responsive.
        task = asyncio.create_task(self._deliver(recorder, recording, upload_url, failed_url, token))
        self.uploads.add(task)
        task.add_done_callback(self.uploads.discard)
        return True, None

    async def _report(self, failed_url: str, token: str, error: str) -> None:
        if failed_url and token:
            await report_failure(failed_url, token, error)

    async def _deliver(self, recorder, recording, upload_url, failed_url, token) -> None:
        try:
            await upload_recording(recording, upload_url, token)
            print(f"[bridge] uploaded {recording.duration_ms / 1000:.0f}s of screen recording")
            recorder.discard()
            return
        except Exception as exc:
            error = str(exc)

        # A session cannot be repeated, so a lost upload must leave the file
        # where a person can still find it.
        self.keep_dir.mkdir(parents=True, exist_ok=True)
        kept = self.keep_dir / f"screen-{recording.epoch_ms}.mp4"
        try:
            shutil.move(str(recording.path), kept)
            print(f"[bridge] upload failed ({error}); kept the recording at {kept}")
            error = f"{error} — the file is on the lab machine at {kept}"
        except Exception:
            print(f"[bridge] upload failed ({error}) and the file could not be kept either")
            recorder.discard()
        await self._report(failed_url, token, error)

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


async def _serve(
    port: int, host: str, mock: bool, allowed_origins: set[str], screen: ScreenSession
) -> None:
    # One tracker, shared. A source per connection meant a second tab fighting
    # the first for the subscription and for calibration mode.
    source = build_source(mock)

    async def handler(ws) -> None:
        origin = ws.request.headers.get("Origin") if hasattr(ws, "request") else None
        if allowed_origins and origin not in allowed_origins:
            # A participant's live gaze is not for any page that asks.
            print(f"[bridge] refused a connection from origin {origin!r}")
            await ws.close(code=4403, reason="origin not allowed")
            return

        area = source.display_area_mm
        await ws.send(
            json.dumps(
                {
                    "type": "status",
                    "connected": source.connected,
                    "frequency": source.frequency,
                    "display_w_mm": area[0] if area else None,
                    "display_h_mm": area[1] if area else None,
                    # So the browser knows whether to expect a screen recording
                    # at all, rather than asking and reporting a failure.
                    "screen_recording": screen.available,
                }
            )
        )
        producer: asyncio.Task | None = None
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if await _handle_calibration(ws, source, msg):
                    continue
                if await _handle_screen(ws, screen, msg):
                    continue
                kind = msg.get("type")
                if kind == "start_gaze" and producer is None and source.connected:
                    producer = asyncio.create_task(source.stream(ws))
                elif kind == "stop_gaze" and producer is not None:
                    producer.cancel()
                    producer = None
        finally:
            if producer is not None:
                producer.cancel()
            await screen.release(ws)
            await source.calibration_abort()

    try:
        async with websockets.serve(handler, host, port):
            print(f"[bridge] listening on ws://{host}:{port} ({'mock' if mock else 'tobii'})")
            print(f"[bridge] accepting origins: {', '.join(sorted(allowed_origins)) or 'any'}")
            if screen.available:
                print("[bridge] screen recording enabled (ffmpeg found)")
            elif screen.enabled:
                print("[bridge] screen recording unavailable: ffmpeg is not on PATH")
            await asyncio.Future()  # run until interrupted
    finally:
        await screen.release(screen.owner)
        await screen.drain()
        source.close()


def wants_test_pattern(screen_source: str, mock: bool) -> bool:
    """Whether to capture ffmpeg's test pattern instead of the display.

    `auto` follows --mock, because a machine with no tracker is usually not the
    lab machine either. `display` is the override: on a laptop it is the only
    way to see the cursor and the pauses in a replay, which is the whole reason
    the capture exists, and mock gaze is the only gaze available there.
    """
    return screen_source == "test-pattern" or (screen_source == "auto" and mock)


def main() -> None:
    ap = argparse.ArgumentParser(description="A04 Tobii → WebSocket bridge")
    ap.add_argument("--port", type=int, default=8765)
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
        Path(args.screen_keep_dir) if args.screen_keep_dir else Path(__file__).parent / "unsent-recordings",
    )
    try:
        asyncio.run(_serve(args.port, args.host, args.mock, origins, screen))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
