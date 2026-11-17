from __future__ import annotations

import asyncio
import contextlib
import ctypes
import json
import socket
import threading
from ctypes import wintypes
from dataclasses import replace

import pytest
import websockets

from native_viewport import (
    NativeObservation,
    Rect,
    ViewportError,
    ViewportRegistry,
    WindowsViewportProvider,
    sample_metadata,
)
from tobii_bridge import MockSource, _serve, _ViewportSocket

TAB = "a" * 32
OTHER = "b" * 32
CSS = {"w": 1200, "h": 800}


def message(tab=TAB, **changes):
    return {
        "type": "viewport_probe",
        "request_id": "probe-1",
        "tab_id": tab,
        "css": CSS,
        "dpr": 1,
        **changes,
    }


class Provider:
    available = True

    def __init__(self):
        self.active = TAB
        self.error = None
        self.observation = NativeObservation(
            Rect(0, 0, 1920, 1080), Rect(88, 142, 1200, 800), 1200, 800, 1, 1, 2
        )

    def foreground_tab(self):
        return self.active

    def observe(self, tab, css, dpr, cached=None):
        if self.error:
            raise ViewportError(self.error)
        if tab != self.active:
            raise ViewportError("not_foreground")
        return replace(self.observation, css_w=css["w"], css_h=css["h"], dpr=dpr)


@pytest.fixture
def registry():
    provider = Provider()
    now = [1000.0]
    registry = ViewportRegistry(
        provider, wall_time=lambda: now[0], monotonic=lambda: now[0]
    )
    return registry, provider, now


def test_proof_stays_stable_only_while_the_measured_mapping_stays_the_same(registry):
    registry, provider, now = registry
    owner = object()
    first = registry.probe(owner, message())
    assert first["ok"]
    proof = first["native_viewport"]
    assert proof["content"] == {"x": 88, "y": 142, "w": 1200, "h": 800}
    assert "hwnd" not in json.dumps(proof)
    now[0] += 0.1
    assert registry.probe(owner, message())["native_viewport"]["id"] == proof["id"]
    assert registry.sample_metadata() == {
        "viewport_id": proof["id"],
        "viewport_ts": 1000100,
        "viewport_tab_id": TAB,
    }
    provider.observation = replace(
        provider.observation, content=Rect(120, 200, 1200, 800)
    )
    assert registry.sample_metadata()["viewport_id"] is None
    moved = registry.probe(owner, message())["native_viewport"]
    assert moved["id"] != proof["id"]
    assert registry.sample_metadata()["viewport_id"] == moved["id"]


def test_expired_probe_loses_its_id_even_when_geometry_is_unchanged(registry):
    registry, _provider, now = registry
    owner = object()
    first = registry.probe(owner, message())["native_viewport"]["id"]
    now[0] += 2.001
    assert registry.sample_metadata()["viewport_id"] is None
    assert registry.probe(owner, message())["native_viewport"]["id"] != first


def test_focus_loss_and_return_require_a_new_probe_and_identifier(registry):
    registry, provider, _now = registry
    owner = object()
    first = registry.probe(owner, message())["native_viewport"]["id"]
    provider.active = None
    assert registry.sample_metadata()["viewport_id"] is None
    provider.active = TAB
    assert registry.sample_metadata()["viewport_id"] is None
    assert registry.probe(owner, message())["native_viewport"]["id"] != first


def test_tab_nonce_is_owned_by_its_geometry_socket_and_disconnect_revokes_it(registry):
    registry, provider, _now = registry
    owner, other = object(), object()
    first = registry.probe(owner, message())["native_viewport"]["id"]
    assert registry.probe(other, message())["error_code"] == "tab_owned"
    assert registry.sample_metadata()["viewport_id"] == first
    registry.unregister(other)
    assert registry.sample_metadata()["viewport_id"] == first
    registry.unregister(owner)
    assert registry.sample_metadata()["viewport_id"] is None
    assert registry.probe(other, message())["native_viewport"]["id"] != first
    provider.active = OTHER
    assert registry.probe(other, message(OTHER))["ok"]
    provider.active = TAB
    assert registry.sample_metadata()["viewport_id"] is None
    assert registry.probe(owner, message())["ok"]


def test_multiple_tabs_can_register_but_only_the_foreground_tab_has_proof(registry):
    registry, provider, _now = registry
    first_owner, second_owner = object(), object()
    registry.probe(first_owner, message())
    assert (
        registry.probe(second_owner, message(OTHER))["error_code"] == "not_foreground"
    )
    assert registry.sample_metadata()["viewport_tab_id"] == TAB
    provider.active = OTHER
    assert registry.sample_metadata()["viewport_id"] is None
    registry.probe(second_owner, message(OTHER))
    assert registry.sample_metadata()["viewport_tab_id"] == OTHER


@pytest.mark.parametrize(
    "changes",
    [
        {"tab_id": "A" * 32},
        {"tab_id": []},
        {"request_id": ""},
        {"request_id": 1},
        {"request_id": "x" * 129},
        {"css": []},
        {"css": {"w": 1200}},
        {"css": {"w": True, "h": 800}},
        {"css": {"w": float("nan"), "h": 800}},
        {"css": {"w": 1200, "h": 800, "x": 1}},
        {"dpr": True},
        {"dpr": 0},
        {"dpr": float("inf")},
        {"dpr": "1"},
    ],
)
def test_probe_rejects_malformed_metadata(registry, changes):
    registry, _provider, _now = registry
    reply = registry.probe(object(), message(**changes))
    assert not reply["ok"] and reply["error_code"] == "invalid_probe"
    json.dumps(reply, allow_nan=False)


def test_native_errors_do_not_certify_geometry_or_break_raw_gaze(registry):
    registry, provider, _now = registry
    owner = object()
    first = registry.probe(owner, message())["native_viewport"]["id"]
    provider.error = "multiple_displays"
    assert registry.sample_metadata()["viewport_id"] is None
    assert registry.probe(owner, message())["error_code"] == "multiple_displays"
    provider.error = None
    assert registry.probe(owner, message())["native_viewport"]["id"] != first
    assert (
        sample_metadata(lambda: (_ for _ in ()).throw(RuntimeError()))["viewport_id"]
        is None
    )
    assert sample_metadata(lambda: {"lx": 99, "viewport_id": "test"}) == {
        "viewport_id": "test"
    }


def test_native_callback_never_waits_for_the_probe_lock(registry):
    registry, _provider, _now = registry
    registry.probe(object(), message())
    acquired, release = threading.Event(), threading.Event()

    def hold():
        with registry._lock:
            acquired.set()
            release.wait(2)

    worker = threading.Thread(target=hold)
    worker.start()
    assert acquired.wait(1)
    try:
        assert registry.sample_metadata()["viewport_id"] is None
    finally:
        release.set()
        worker.join(1)


class User32:
    def __init__(self):
        self.foreground = 1
        self.title = f"Study [A04:{TAB}] — Microsoft Edge"
        self.displays = [Rect(0, 0, 1920, 1080)]
        self.children = {2: Rect(88, 142, 1200, 800)}
        self.enumerations = 0

    def GetForegroundWindow(self):
        return self.foreground

    def GetWindowTextW(self, _handle, value, _size):
        value.value = self.title

    def IsWindowVisible(self, handle):
        return handle == 1 or handle in self.children

    def IsIconic(self, _handle):
        return False

    def GetAncestor(self, _handle, _kind):
        return 1

    def GetClassNameW(self, _handle, value, _size):
        value.value = "Chrome_RenderWidgetHostHWND"

    def GetClientRect(self, handle, bounds):
        rect = self.children[handle]
        bounds._obj.right, bounds._obj.bottom = rect.w, rect.h
        return True

    def ClientToScreen(self, handle, point):
        rect = self.children[handle]
        point._obj.x, point._obj.y = rect.x, rect.y
        return True

    def EnumChildWindows(self, _root, callback, data):
        self.enumerations += 1
        for child in self.children:
            callback(child, data)
        return True

    def EnumDisplayMonitors(self, _dc, _rect, callback, data):
        for rect in self.displays:
            bounds = wintypes.RECT(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h)
            callback(None, None, ctypes.pointer(bounds), data)
        return True


@pytest.fixture
def native():
    provider = WindowsViewportProvider.__new__(WindowsViewportProvider)
    provider.available, provider.wintypes = True, wintypes
    provider.user32 = User32()
    provider.window_callback = provider.monitor_callback = lambda callback: callback
    provider._physical_pixels = contextlib.nullcontext
    return provider, provider.user32


def test_native_provider_uses_content_origin_instead_of_browser_chrome(native):
    provider, api = native
    found = provider.observe(TAB, CSS, 1)
    assert found.content == Rect(88, 142, 1200, 800)
    assert provider.observe(TAB, CSS, 1, cached=found) == found
    assert api.enumerations == 1
    api.children[2] = Rect(0, 0, 1920, 1080)
    full = provider.observe(TAB, {"w": 1536, "h": 864}, 1.25, cached=found)
    assert full.content == Rect(0, 0, 1920, 1080)
    assert api.enumerations == 2


def test_native_provider_rejects_ambiguous_or_mismatched_content(native):
    provider, api = native
    api.children[3] = api.children[2]
    with pytest.raises(ViewportError, match="viewport_ambiguous"):
        provider.observe(TAB, CSS, 1)
    api.children = {2: Rect(88, 142, 1197, 800)}
    with pytest.raises(ViewportError, match="viewport_size_mismatch"):
        provider.observe(TAB, CSS, 1)
    api.children = {}
    with pytest.raises(ViewportError, match="viewport_unavailable"):
        provider.observe(TAB, CSS, 1)


def test_native_provider_rejects_another_tab_and_multiple_monitors(native):
    provider, api = native
    api.title = "Another tab"
    with pytest.raises(ViewportError, match="not_foreground"):
        provider.observe(TAB, CSS, 1)
    api.title = f"[A04:{TAB}]"
    api.displays.append(Rect(1920, 0, 1920, 1080))
    with pytest.raises(ViewportError, match="multiple_displays"):
        provider.observe(TAB, CSS, 1)


class Socket:
    def __init__(self):
        self.messages = []

    async def send(self, raw):
        self.messages.append(json.loads(raw))


@pytest.mark.asyncio
@pytest.mark.parametrize("requested", [TAB, OTHER, None, "bad"])
async def test_shared_source_does_not_lend_viewport_proof_to_another_tab(requested):
    socket = Socket()
    scoped = _ViewportSocket(socket, requested)
    await scoped.send(
        json.dumps(
            {
                "type": "gaze",
                "lx": 0.2,
                "viewport_id": "bridge:1",
                "viewport_ts": 1234,
                "viewport_tab_id": TAB,
            }
        )
    )
    assert socket.messages == [
        {
            "type": "gaze",
            "lx": 0.2,
            "viewport_id": "bridge:1" if requested == TAB else None,
            "viewport_ts": 1234,
        }
    ]


@pytest.mark.asyncio
async def test_missing_tab_correlation_never_lends_a_proof_to_the_gaze_client():
    socket = Socket()
    await _ViewportSocket(socket, TAB).send(
        json.dumps(
            {
                "type": "gaze",
                "lx": 0.2,
                "viewport_id": "bridge:1",
                "viewport_ts": 1234,
            }
        )
    )
    assert socket.messages[0]["viewport_id"] is None
    assert socket.messages[0]["lx"] == 0.2


@pytest.mark.asyncio
async def test_mock_frames_use_the_same_capture_time_metadata_contract():
    socket = Socket()
    source = MockSource()
    source.sample_metadata = lambda: {
        "viewport_id": "bridge:1",
        "viewport_ts": 1234,
        "viewport_tab_id": TAB,
    }
    task = asyncio.create_task(source.stream(_ViewportSocket(socket, TAB)))
    try:
        for _ in range(20):
            if socket.messages:
                break
            await asyncio.sleep(0.005)
        assert socket.messages[0]["viewport_id"] == "bridge:1"
        assert socket.messages[0]["viewport_ts"] == 1234
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_probe_protocol_owns_geometry_separately_from_gaze_connections(
    monkeypatch,
):
    provider = Provider()
    registry = ViewportRegistry(provider)
    monkeypatch.setattr("tobii_bridge.ViewportRegistry", lambda: registry)

    class Screen:
        available = audio_available = enabled = False
        owner = None

        async def release(self, _ws):
            pass

        async def drain(self):
            pass

    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    server = asyncio.create_task(
        _serve(port, "127.0.0.1", True, {"https://study.test"}, Screen())
    )

    async def connect():
        for _ in range(50):
            try:
                ws = await websockets.connect(
                    f"ws://127.0.0.1:{port}", origin="https://study.test"
                )
                status = json.loads(await ws.recv())
                assert status["native_viewport"] is True
                return ws
            except OSError:
                await asyncio.sleep(0.01)
        pytest.fail("bridge did not listen")

    sockets = []
    try:
        geometry = await connect()
        sockets.append(geometry)
        await geometry.send(json.dumps(message()))
        response = json.loads(await geometry.recv())
        assert response["ok"]
        identifier = response["native_viewport"]["id"]
        own = await connect()
        sockets.append(own)
        await own.send(json.dumps({"type": "start_gaze", "tab_id": TAB}))
        frame = json.loads(await own.recv())
        assert frame["viewport_id"] == identifier and "viewport_tab_id" not in frame
        other = await connect()
        sockets.append(other)
        await other.send(json.dumps({"type": "start_gaze", "tab_id": OTHER}))
        assert json.loads(await other.recv())["viewport_id"] is None
        await geometry.close()
        for _ in range(50):
            if registry.sample_metadata()["viewport_id"] is None:
                break
            await asyncio.sleep(0.01)
        assert registry.sample_metadata()["viewport_id"] is None
    finally:
        for ws in sockets:
            await ws.close()
        server.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server
