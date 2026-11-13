from __future__ import annotations

import asyncio
import contextlib
import json
import threading
from types import SimpleNamespace

import pytest
from gaze_source import TobiiSource, gaze_frame
from tracker_diagnostics import diagnose_tracker


class Tracker:
    model = "Test Pro"

    def __init__(self):
        self.callbacks = []
        self.subscriptions = self.unsubscriptions = 0
        self.fail_subscribe = False
        self.fail_unsubscribe = False
        self.on_subscribe = None

    def get_gaze_output_frequency(self):
        return 120

    def get_display_area(self):
        return SimpleNamespace(width=530, height=300)

    def subscribe_to(self, kind, callback, as_dictionary=False):
        assert kind == "gaze" and as_dictionary
        self.subscriptions += 1
        if self.fail_subscribe:
            raise RuntimeError("SDK refused subscription")
        self.callbacks.append(callback)
        if self.on_subscribe:
            self.on_subscribe(callback)

    def unsubscribe_from(self, kind, callback):
        assert kind == "gaze"
        self.unsubscriptions += 1
        if self.fail_unsubscribe:
            raise RuntimeError("SDK refused cleanup")
        self.callbacks.remove(callback)

    def emit(self, valid=True):
        for callback in list(self.callbacks):
            callback(sample(valid))


def sample(valid=True):
    return {
        "left_gaze_point_validity": int(valid),
        "right_gaze_point_validity": int(valid),
        "left_gaze_point_on_display_area": (0.25, 0.75),
        "right_gaze_point_on_display_area": (0.25, 0.75),
        "device_time_stamp": 1234,
    }


class SDK:
    __version__ = "2.1.0-test"
    EYETRACKER_GAZE_DATA = "gaze"

    def __init__(self, trackers):
        self.trackers = trackers
        self.discovery_calls = 0
        self.fail_discovery = False

    def find_all_eyetrackers(self):
        self.discovery_calls += 1
        if self.fail_discovery:
            raise RuntimeError("SDK discovery unavailable")
        return self.trackers


class Socket:
    def __init__(self):
        self.messages = []

    async def send(self, raw):
        self.messages.append(json.loads(raw))


async def until(predicate, timeout=1):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("condition did not become true")
        await asyncio.sleep(0.005)


async def cancel(task):
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def source(sdk, **options):
    return TobiiSource(
        sdk, retry_seconds=0.015, sample_timeout=0.08, status_seconds=0.02, **options
    )


@pytest.mark.asyncio
async def test_late_tracker_is_discovered_and_real_samples_are_forwarded(capsys):
    sdk, tracker, ws = SDK([]), Tracker(), Socket()
    gaze = source(sdk)
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: any(m.get("error_code") == "tracker_missing" for m in ws.messages))
        assert not gaze.connected
        sdk.trackers.append(tracker)
        await until(lambda: bool(tracker.callbacks))
        tracker.emit()
        await until(lambda: any(m["type"] == "gaze" for m in ws.messages))
        frame = next(m for m in ws.messages if m["type"] == "gaze")
        assert frame["lx"] == 0.25 and frame["ts"] > 0 and frame["device_ts"] == 1234
        assert gaze.sample_count == gaze.valid_sample_count == 1
        assert gaze.connected and gaze.subscribed
    finally:
        await cancel(task)
    assert tracker.unsubscriptions == 1 and not tracker.callbacks
    output = capsys.readouterr().out
    assert "first sample" in output and "0.25" not in output and "0.75" not in output


@pytest.mark.asyncio
async def test_multiple_clients_share_one_subscription_and_reconnect_overlap():
    tracker, a, b = Tracker(), Socket(), Socket()
    gaze = source(SDK([tracker]))
    first = asyncio.create_task(gaze.stream(a))
    await until(lambda: bool(tracker.callbacks))
    second = asyncio.create_task(gaze.stream(b))
    await until(lambda: len(gaze._listeners) == 2)
    tracker.emit()
    await until(lambda: any(m["type"] == "gaze" for m in b.messages))
    await cancel(first)
    assert tracker.subscriptions == 1 and tracker.unsubscriptions == 0
    tracker.emit()
    await until(lambda: len([m for m in b.messages if m["type"] == "gaze"]) == 2)
    await cancel(second)
    assert tracker.unsubscriptions == 1


@pytest.mark.asyncio
async def test_subscription_failure_is_reported_and_recovers():
    tracker, ws = Tracker(), Socket()
    tracker.fail_subscribe = True
    gaze = source(SDK([tracker]))
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: gaze.error_code == "subscription_failed")
        assert gaze.connected and not gaze.subscribed
        tracker.fail_subscribe = False
        await until(lambda: bool(tracker.callbacks))
        tracker.emit()
        await until(lambda: gaze.valid_sample_count == 1)
        assert gaze.error is None
    finally:
        await cancel(task)


@pytest.mark.asyncio
async def test_discovery_exception_is_retryable_without_blocking_other_tasks():
    sdk = SDK([Tracker()])
    sdk.fail_discovery = True
    gaze, ws = source(sdk), Socket()
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: gaze.error_code == "discovery_failed")
        sdk.fail_discovery = False
        await until(lambda: gaze.subscribed)
        assert gaze.connected
    finally:
        await cancel(task)


@pytest.mark.asyncio
async def test_no_callbacks_are_reported_and_subscription_retried():
    tracker, ws = Tracker(), Socket()
    gaze = source(SDK([tracker]))
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: any(m.get("error_code") == "no_samples" for m in ws.messages))
        await until(lambda: tracker.subscriptions >= 2)
        assert gaze.sample_count == 0 and tracker.unsubscriptions >= 1
    finally:
        await cancel(task)


@pytest.mark.asyncio
async def test_invalid_samples_are_distinct_from_no_samples_and_valid_eyes_clear_warning():
    tracker, ws = Tracker(), Socket()
    gaze = source(SDK([tracker]))
    task = asyncio.create_task(gaze.stream(ws))
    emitter = None
    try:
        await until(lambda: bool(tracker.callbacks))

        async def keep_sending_invalid_samples():
            while True:
                tracker.emit(False)
                await asyncio.sleep(0.02)

        emitter = asyncio.create_task(keep_sending_invalid_samples())
        await until(lambda: gaze.error_code == "invalid_samples")
        assert gaze.sample_count > 0 and gaze.valid_sample_count == 0
        assert tracker.subscriptions == 1
        await cancel(emitter)
        emitter = None
        tracker.emit(True)
        await until(lambda: gaze.valid_sample_count == 1)
        assert gaze.error is None
    finally:
        if emitter is not None:
            await cancel(emitter)
        await cancel(task)


@pytest.mark.asyncio
async def test_cancellation_during_sdk_subscribe_unsubscribes_after_sdk_returns():
    tracker, ws = Tracker(), Socket()
    entered, release = threading.Event(), threading.Event()

    def delayed(_callback):
        entered.set()
        release.wait(1)

    tracker.on_subscribe = delayed
    gaze = source(SDK([tracker]))
    task = asyncio.create_task(gaze.stream(ws))
    await until(entered.is_set)
    task.cancel()
    release.set()
    await cancel(task)
    assert not tracker.callbacks and tracker.unsubscriptions == 1


@pytest.mark.asyncio
async def test_failed_cleanup_prevents_overlapping_subscriptions_then_recovers():
    tracker, ws = Tracker(), Socket()
    gaze = source(SDK([tracker]))
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: bool(tracker.callbacks))
        tracker.fail_unsubscribe = True
        await until(lambda: gaze.error_code == "unsubscribe_failed")
        assert tracker.subscriptions == 1
        tracker.fail_unsubscribe = False
        await until(lambda: tracker.subscriptions >= 2)
        assert len(tracker.callbacks) == 1
    finally:
        tracker.fail_unsubscribe = False
        await cancel(task)


def test_nonfinite_coordinates_do_not_count_as_valid_eyes():
    event = sample()
    event["left_gaze_point_on_display_area"] = (float("nan"), 0.25)
    event["right_gaze_point_on_display_area"] = (0.25, float("inf"))
    frame = gaze_frame(event)
    assert not frame["lv"] and not frame["rv"]
    assert frame["lx"] is None and frame["rx"] is None
    json.dumps(frame, allow_nan=False)


@pytest.mark.asyncio
async def test_diagnostic_reports_counts_without_positions_and_unsubscribes():
    tracker = Tracker()
    tracker.on_subscribe = lambda callback: callback(sample())
    report = await diagnose_tracker(0.05, sdk=SDK([tracker]))
    assert report["ok"] and report["sample_count"] == report["valid_sample_count"] == 1
    assert report["sdk_version"] == "2.1.0-test" and report["model"] == "Test Pro"
    assert report["frequency"] == 120 and tracker.unsubscriptions == 1
    text = json.dumps(report)
    assert "0.25" not in text and "0.75" not in text and "device_ts" not in text


@pytest.mark.asyncio
async def test_diagnostic_reports_missing_device_separately():
    report = await diagnose_tracker(0.03, sdk=SDK([]))
    assert not report["ok"] and report["error_code"] == "tracker_missing"
    assert report["sample_count"] == 0


@pytest.mark.asyncio
async def test_resubscription_does_not_reuse_old_sample_count_as_stream_readiness():
    tracker, ws = Tracker(), Socket()
    tracker.on_subscribe = lambda callback: (
        callback(sample()) if tracker.subscriptions == 1 else None
    )
    gaze = source(SDK([tracker]))
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: tracker.subscriptions == 2 and gaze.state == "waiting_for_samples")
        index = len(ws.messages)
        await asyncio.sleep(0.04)
        assert gaze.sample_count == 1
        assert not any(m.get("state") == "streaming" for m in ws.messages[index:])
    finally:
        await cancel(task)


@pytest.mark.asyncio
async def test_stale_malformed_callback_cannot_override_new_subscription_status():
    tracker, ws = Tracker(), Socket()
    gaze = source(SDK([tracker]))
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: bool(tracker.callbacks))
        old = tracker.callbacks[0]
        await until(lambda: tracker.subscriptions == 2 and bool(tracker.callbacks))
        old(None)
        await asyncio.sleep(0.01)
        assert gaze.error_code != "invalid_callback"
        tracker.emit()
        await until(lambda: gaze.valid_sample_count == 1)
    finally:
        await cancel(task)


@pytest.mark.asyncio
async def test_stuck_sdk_call_is_bounded_and_never_overlapped():
    gate = threading.Event()
    sdk = SDK([Tracker()])
    calls = []

    def blocked():
        calls.append(1)
        gate.wait(2)
        return sdk.trackers

    sdk.find_all_eyetrackers = blocked
    gaze = source(sdk, sdk_timeout=0.03)
    try:
        await asyncio.wait_for(gaze.refresh(), 0.2)
        assert gaze.error_code == "discovery_failed"
        await asyncio.wait_for(gaze.refresh(), 0.2)
        assert len(calls) == 1 and not gaze.connected
        gate.set()
        await until(lambda: gaze._sdk_pending.done())
        await gaze.refresh()
        assert gaze.connected and len(calls) == 2
    finally:
        gate.set()
        await gaze.close()


@pytest.mark.asyncio
async def test_slow_sdk_cannot_delay_screen_handshake_commands_or_release(monkeypatch):
    import socket

    import websockets
    from tobii_bridge import DEFAULT_ORIGINS, _serve

    gate = threading.Event()
    sdk = SDK([])
    sdk.find_all_eyetrackers = lambda: (gate.wait(2), [])[1]
    gaze = source(sdk, sdk_timeout=1)
    monkeypatch.setattr("tobii_bridge.build_source", lambda _mock: gaze)
    released = asyncio.Event()

    class Screen:
        available = audio_available = True
        enabled = True
        owner = None

        async def start(self, ws, _msg):
            self.owner = ws
            return True, None

        async def release(self, _ws):
            released.set()

        async def drain(self):
            pass

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = asyncio.create_task(_serve(port, "127.0.0.1", False, set(DEFAULT_ORIGINS), Screen()))
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
            pytest.fail("bridge did not listen")
        status = json.loads(await asyncio.wait_for(ws.recv(), 0.2))
        assert status["type"] == "status" and status["screen_recording"] is True
        await ws.send(json.dumps({"type": "start_gaze"}))
        await ws.send(json.dumps({"type": "start_screen_recording"}))
        while True:
            response = json.loads(await asyncio.wait_for(ws.recv(), 0.2))
            if response["type"] == "screen_recording_started":
                assert response["ok"]
                break
        await ws.close()
        await asyncio.wait_for(released.wait(), 0.2)
        assert not gate.is_set()
    finally:
        gate.set()
        await cancel(server)


@pytest.mark.asyncio
async def test_screen_only_connection_does_not_rediscover_a_known_tracker(monkeypatch):
    import socket

    import websockets
    from tobii_bridge import DEFAULT_ORIGINS, _serve

    sdk = SDK([Tracker()])
    gaze = source(sdk)
    monkeypatch.setattr("tobii_bridge.build_source", lambda _mock: gaze)

    class Screen:
        available = audio_available = enabled = False
        owner = None

        async def release(self, _ws):
            pass

        async def drain(self):
            pass

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = asyncio.create_task(_serve(port, "127.0.0.1", False, set(DEFAULT_ORIGINS), Screen()))
    try:
        await until(lambda: gaze.connected)
        assert sdk.discovery_calls == 1
        async with websockets.connect(
            f"ws://127.0.0.1:{port}", origin="https://a04.rdm.lab.lrz.de"
        ) as ws:
            assert json.loads(await ws.recv())["connected"] is True
            await asyncio.sleep(0.03)
            assert sdk.discovery_calls == 1
    finally:
        await cancel(server)


@pytest.mark.asyncio
async def test_sample_in_subscription_start_clock_tick_is_still_streaming():
    tracker, ws = Tracker(), Socket()
    gaze = source(SDK([tracker]))

    def immediate(callback):
        callback(sample())

    tracker.on_subscribe = immediate
    original_receive = gaze._receive

    def same_clock_tick(frame, generation):
        original_receive(frame, generation)
        gaze._last_sample = gaze._started

    gaze._receive = same_clock_tick
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: gaze.sample_count == 1 and gaze._pending_cleanup is not None)
        await asyncio.sleep(0.02)
        statuses = [m["state"] for m in ws.messages if m["type"] == "gaze_status"]
        assert "streaming" in statuses
        assert "waiting_for_samples" not in statuses[statuses.index("streaming") :]
    finally:
        await cancel(task)


@pytest.mark.asyncio
async def test_timed_out_subscription_that_later_succeeds_is_cleaned_before_retry():
    tracker, ws = Tracker(), Socket()
    gate = threading.Event()
    tracker.on_subscribe = lambda _callback: gate.wait(2) if tracker.subscriptions == 1 else None
    gaze = source(SDK([tracker]), sdk_timeout=0.03)
    task = asyncio.create_task(gaze.stream(ws))
    try:
        await until(lambda: gaze.error_code == "subscription_failed")
        assert tracker.subscriptions == 1
        gate.set()
        await until(lambda: tracker.subscriptions == 2)
        assert tracker.unsubscriptions == 1
        assert len(tracker.callbacks) == 1
        tracker.emit()
        await until(lambda: gaze.valid_sample_count == 1)
    finally:
        gate.set()
        await cancel(task)
    assert not tracker.callbacks
