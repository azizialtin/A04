"""A recoverable Tobii subscription shared by the browser's gaze clients."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import importlib
import json
import math
import threading
import time


def gaze_frame(gaze: dict) -> dict:
    stamp = gaze.get("device_time_stamp")
    frame = {
        "type": "gaze",
        "ts": int(time.time() * 1000),
        "device_ts": stamp if isinstance(stamp, (int, float)) and math.isfinite(stamp) else None,
    }
    distances = []
    for side, prefix in (("left", "l"), ("right", "r")):
        point = gaze.get(f"{side}_gaze_point_on_display_area", ())
        valid = (
            gaze.get(f"{side}_gaze_point_validity") == 1
            and isinstance(point, (tuple, list))
            and len(point) == 2
            and all(isinstance(value, (float, int)) and math.isfinite(value) for value in point)
        )
        frame.update(
            {
                f"{prefix}v": valid,
                f"{prefix}x": point[0] if valid else None,
                f"{prefix}y": point[1] if valid else None,
            }
        )
        origin = gaze.get(f"{side}_gaze_origin_in_user_coordinate_system", ())
        if (
            gaze.get(f"{side}_gaze_origin_validity") == 1
            and isinstance(origin, (tuple, list))
            and len(origin) == 3
            and isinstance(origin[2], (float, int))
            and math.isfinite(origin[2])
        ):
            distances.append(origin[2])
    frame["dz"] = round(sum(distances) / len(distances), 1) if distances else None
    return frame


class TobiiSource:
    """Enumerate again when requested; never mistake discovery for live samples."""

    source_mode = "tobii"

    def __init__(
        self,
        sdk=None,
        *,
        retry_seconds=2.0,
        sample_timeout=3.0,
        status_seconds=1.0,
        sdk_timeout=5.0,
    ):
        self._tr = sdk
        self.sdk_version = getattr(sdk, "__version__", None)
        self._tracker = None
        self._calibration = None
        self.connected = False
        self.frequency = 0
        self.display_area_mm = None
        self.model = None
        self.sample_count = self.valid_sample_count = 0
        self.first_sample_ms = None
        self.subscribed = False
        self.state = "discovering"
        self.error = self.error_code = None
        self.retry_seconds = retry_seconds
        self.sample_timeout = sample_timeout
        self.status_seconds = status_seconds
        self.sdk_timeout = sdk_timeout
        self._sdk_pending = None
        self._sdk_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._listeners = set()
        self._runner = None
        self._generation = 0
        self._started = self._last_sample = self._last_valid = self._last_status = 0.0
        self._pending_cleanup = None
        self._logged_status = None

    async def _call(self, operation, *args, **kwargs):
        # A stuck native call is quarantined; no second call touches the SDK.
        async with self._sdk_lock:
            if self._sdk_pending is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(self._sdk_pending), self.sdk_timeout)
                except asyncio.TimeoutError:
                    raise
                except Exception:
                    pass
            future = concurrent.futures.Future()

            def invoke():
                try:
                    future.set_result(operation(*args, **kwargs))
                except BaseException as exc:
                    future.set_exception(exc)

            pending = asyncio.wrap_future(future)
            pending.add_done_callback(
                lambda done: done.exception() if not done.cancelled() else None
            )
            self._sdk_pending = pending
            threading.Thread(target=invoke, daemon=True, name="a04-tobii-sdk").start()
            try:
                return await asyncio.wait_for(asyncio.shield(pending), self.sdk_timeout)
            finally:
                if pending.done():
                    self._sdk_pending = None

    def status(self):
        return {
            "type": "gaze_status",
            "source_mode": self.source_mode,
            "state": self.state,
            "connected": self.connected,
            "subscribed": self.subscribed,
            "sample_count": self.sample_count,
            "valid_sample_count": self.valid_sample_count,
            "first_sample_ms": self.first_sample_ms,
            "frequency": self.frequency,
            "error": self.error,
            "error_code": self.error_code,
            "sdk_version": self.sdk_version,
            "model": self.model,
        }

    def _publish(self, message):
        encoded = json.dumps(message, allow_nan=False)
        for queue in tuple(self._listeners):
            if queue.full():
                self._listeners.discard(queue)
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(
                    json.dumps(
                        {
                            **self.status(),
                            "state": "error",
                            "error_code": "client_slow",
                            "error": "Gaze delivery fell behind; reconnect the study page.",
                        }
                    )
                )
            else:
                queue.put_nowait(encoded)

    def _status(self, state, code=None, message=None):
        self.state, self.error_code, self.error = state, code, message
        signature = state, code, message, self.model, self.sdk_version
        if signature != self._logged_status:
            print(
                f"[gaze] {state}: SDK={self.sdk_version or 'unavailable'}, "
                f"model={self.model or 'none'}, samples={self.sample_count}, "
                f"valid={self.valid_sample_count}" + (f"; {message}" if message else ""),
                flush=True,
            )
            self._logged_status = signature
        self._last_status = asyncio.get_running_loop().time()
        self._publish(self.status())

    def _discover(self):
        if self._pending_cleanup is not None and self._tracker is not None:
            return self._tracker, self.frequency, self.display_area_mm, self.model
        if self._tr is None:
            self._tr = importlib.import_module("tobii_research")
        self.sdk_version = getattr(self._tr, "__version__", "unknown")
        trackers = self._tr.find_all_eyetrackers()
        tracker = trackers[0] if trackers else None
        if tracker is None:
            return None, 0, None, None
        frequency = int(tracker.get_gaze_output_frequency())
        try:
            area = tracker.get_display_area()
            size = float(area.width), float(area.height)
        except Exception:
            size = None
        return tracker, frequency, size, str(getattr(tracker, "model", "Tobii Pro"))

    async def refresh(self):
        if self.subscribed or self._pending_cleanup is not None:
            return
        try:
            self._tracker, self.frequency, self.display_area_mm, self.model = await self._call(
                self._discover
            )
            self.connected = self._tracker is not None
        except Exception as exc:
            self.connected = False
            self._tracker = None
            self.frequency, self.display_area_mm, self.model = 0, None, None
            code = "sdk_unavailable" if self._tr is None else "discovery_failed"
            self._status(
                "error",
                code,
                f"Tracker discovery failed ({type(exc).__name__}). "
                "Run Check-eye-tracker.cmd and check the installed SDK and Eye Tracker Manager.",
            )
            return
        if not self.connected:
            self._status(
                "waiting_for_tracker",
                "tracker_missing",
                "No compatible Tobii Pro tracker found. Check power/cable and the model's SDK compatibility; retrying.",
            )
        elif not self._listeners:
            self._status("stopped")

    def _receive(self, frame, generation):
        if generation != self._generation:
            return
        now = asyncio.get_running_loop().time()
        self.subscribed = True
        self.sample_count += 1
        self.valid_sample_count += int(frame["lv"] or frame["rv"])
        if frame["lv"] or frame["rv"]:
            self._last_valid = now
        self._last_sample = now
        if self.first_sample_ms is None:
            self.first_sample_ms = round((now - self._started) * 1000)
            print(
                f"[gaze] first sample after {self.first_sample_ms} ms; "
                f"valid eyes={'yes' if frame['lv'] or frame['rv'] else 'no'}",
                flush=True,
            )
        self._publish(frame)
        if self.state != "streaming" or (
            self.error_code == "invalid_samples" and (frame["lv"] or frame["rv"])
        ):
            self._status("streaming")

    def _callback_error(self, generation):
        if generation == self._generation:
            self._status("error", "invalid_callback", "The SDK supplied an unreadable gaze sample.")

    async def _cleanup(self):
        task = asyncio.create_task(self._unsubscribe())
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await task
            raise

    async def _unsubscribe(self):
        if self._pending_cleanup is None:
            return True
        tracker, callback = self._pending_cleanup
        try:
            await self._call(tracker.unsubscribe_from, self._tr.EYETRACKER_GAZE_DATA, callback)
        except Exception as exc:
            self._status(
                "error",
                "unsubscribe_failed",
                f"Could not stop the previous SDK subscription ({type(exc).__name__}); retrying cleanup before resubscribing.",
            )
            return False
        self._pending_cleanup = None
        self.subscribed = False
        return True

    async def _run(self):
        loop = asyncio.get_running_loop()
        try:
            while self._listeners:
                if not await self._cleanup():
                    await asyncio.sleep(self.retry_seconds)
                    continue
                await self.refresh()
                if not self.connected:
                    await asyncio.sleep(self.retry_seconds)
                    continue
                tracker = self._tracker
                self._generation += 1
                generation = self._generation

                def callback(gaze, active=generation):
                    try:
                        frame = gaze_frame(gaze)
                    except (AttributeError, TypeError, ValueError, KeyError):
                        if not loop.is_closed():
                            loop.call_soon_threadsafe(self._callback_error, active)
                        return
                    if not loop.is_closed():
                        loop.call_soon_threadsafe(self._receive, frame, active)

                self._status("subscribing")
                self._started = self._last_sample = self._last_valid = loop.time()
                samples_before_subscribe = self.sample_count
                self._pending_cleanup = tracker, callback
                try:
                    await self._call(
                        tracker.subscribe_to,
                        self._tr.EYETRACKER_GAZE_DATA,
                        callback,
                        as_dictionary=True,
                    )
                except Exception as exc:
                    if self.sample_count == samples_before_subscribe:
                        self._pending_cleanup = None
                    self._status(
                        "error",
                        "subscription_failed",
                        f"The tracker was found but gaze could not start ({type(exc).__name__}). "
                        "Close other recording/calibration tools and check the tracker model/runtime.",
                    )
                    await asyncio.sleep(self.retry_seconds)
                    continue
                self.subscribed = True
                if self._last_sample <= self._started:
                    self._status("waiting_for_samples")
                while self._listeners:
                    await asyncio.sleep(min(0.2, self.sample_timeout / 2))
                    now = loop.time()
                    if now - self._last_sample >= self.sample_timeout:
                        self._status(
                            "no_samples",
                            "no_samples",
                            "The SDK subscription produced no new gaze samples. Check tracker power/runtime and competing applications; retrying.",
                        )
                        break
                    if self.sample_count and now - self._last_valid >= self.sample_timeout:
                        self._status(
                            "streaming",
                            "invalid_samples",
                            "Samples arrive but neither eye is valid. Check participant position and calibration.",
                        )
                    elif now - self._last_status >= self.status_seconds:
                        self._status(
                            "streaming"
                            if self.sample_count > samples_before_subscribe
                            else "waiting_for_samples",
                            self.error_code,
                            self.error,
                        )
                self._generation += 1
        except Exception as exc:
            self._status(
                "error",
                "stream_failed",
                f"Gaze streaming failed ({type(exc).__name__}). Restart gaze capture or run Check-eye-tracker.cmd.",
            )
        finally:
            self._generation += 1
            await self._cleanup()

    async def stream(self, ws):
        queue = asyncio.Queue(maxsize=2048)
        async with self._lifecycle_lock:
            self._listeners.add(queue)
            if self._runner is None or self._runner.done():
                self.sample_count = self.valid_sample_count = 0
                self.first_sample_ms = None
                self._status("discovering")
                self._runner = asyncio.create_task(self._run())
            else:
                queue.put_nowait(json.dumps(self.status()))
        try:
            while True:
                message = await queue.get()
                await ws.send(message)
                if json.loads(message).get("error_code") in {"client_slow", "stream_failed"}:
                    return
        finally:
            async with self._lifecycle_lock:
                self._listeners.discard(queue)
                if not self._listeners and self._runner is not None:
                    runner, self._runner = self._runner, None
                    runner.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await runner

    async def calibration_start(self):
        await self.refresh()
        if not self._tracker:
            return False
        self._calibration = self._tr.ScreenBasedCalibration(self._tracker)
        await self._call(self._calibration.enter_calibration_mode)
        return True

    async def calibration_collect(self, x, y):
        if self._calibration is None:
            return False
        return (
            await self._call(self._calibration.collect_data, x, y)
            == self._tr.CALIBRATION_STATUS_SUCCESS
        )

    async def calibration_compute(self):
        if self._calibration is None:
            return False
        result = await self._call(self._calibration.compute_and_apply)
        await self.calibration_abort()
        return result.status == self._tr.CALIBRATION_STATUS_SUCCESS

    async def calibration_abort(self):
        if self._calibration is not None:
            calibration, self._calibration = self._calibration, None
            await self._call(calibration.leave_calibration_mode)

    async def close(self):
        if self._runner is not None:
            self._runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._runner
        await self._cleanup()
        await self.calibration_abort()
