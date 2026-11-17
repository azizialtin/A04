"""Independent physical-pixel check using a real, headed Edge window on Windows.

Run explicitly with A04_NATIVE_VIEWPORT_WINDOWS_TEST=1. SetCursorPos moves the
actual Windows cursor; DOM pointer events provide the independent reference.
CDP mouse emulation would not establish the native screen/content offset.
No tracker is required and no research data or existing browser profile is used.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
from urllib.error import HTTPError
from uuid import uuid4

import pytest
import websockets


pytestmark = pytest.mark.skipif(
    sys.platform != "win32"
    or os.environ.get("A04_NATIVE_VIEWPORT_WINDOWS_TEST") != "1",
    reason="requires the explicit headed Windows/Edge acceptance run",
)


class CDP:
    def __init__(self, socket):
        self.socket = socket
        self.counter = 0

    async def call(self, method, params=None):
        self.counter += 1
        identifier = self.counter
        await self.socket.send(
            json.dumps({"id": identifier, "method": method, "params": params or {}})
        )

        async def receive():
            while True:
                message = json.loads(await asyncio.wait_for(self.socket.recv(), 15))
                if message.get("id") != identifier:
                    continue
                assert "error" not in message, message
                return message.get("result", {})

        return await asyncio.wait_for(receive(), 15)

    async def evaluate(self, expression):
        result = await self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
                "userGesture": True,
            },
        )
        assert "exceptionDetails" not in result, result
        return result["result"].get("value")


class InterceptingCDP(CDP):
    """Keep request interception responsive while other CDP calls await replies."""

    def __init__(self, socket, intercept):
        super().__init__(socket)
        self.intercept = intercept
        self.pending = {}
        self.tasks = set()
        self.errors = []
        self.runtime_events = []
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                future = self.pending.get(message.get("id"))
                if future is not None and not future.done():
                    future.set_result(message)
                elif message.get("method") == "Fetch.requestPaused":
                    task = asyncio.create_task(self._intercept(message["params"]))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                elif message.get("method") in ("Runtime.exceptionThrown", "Log.entryAdded"):
                    self.runtime_events.append(message)
                    self.runtime_events = self.runtime_events[-100:]
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("Edge CDP closed"))

    async def _intercept(self, params):
        try:
            await self.intercept(self, params)
        except Exception as error:
            self.errors.append(f"{type(error).__name__}: {error}")

    async def call(self, method, params=None):
        self.counter += 1
        identifier = self.counter
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        try:
            await self.socket.send(
                json.dumps({"id": identifier, "method": method, "params": params or {}})
            )
            message = await asyncio.wait_for(future, 20)
            assert "error" not in message, message
            return message.get("result", {})
        finally:
            self.pending.pop(identifier, None)

    async def close(self):
        await self.socket.close()
        await self.reader
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)


async def eventually(function, predicate=lambda value: bool(value), timeout=12):
    until = time.monotonic() + timeout
    last = None
    while time.monotonic() < until:
        last = await function()
        if predicate(last):
            return last
        await asyncio.sleep(0.1)
    raise AssertionError(
        f"Timed out waiting for the native browser condition: {last!r}"
    )


@pytest.mark.asyncio
async def test_real_edge_native_geometry_matches_physical_cursor_and_dom(tmp_path):
    from native_viewport import ViewportError, WindowsViewportProvider

    edge = next(
        (
            p
            for p in [
                Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)"))
                / "Microsoft/Edge/Application/msedge.exe",
                Path(os.environ.get("PROGRAMFILES", "C:/Program Files"))
                / "Microsoft/Edge/Application/msedge.exe",
            ]
            if p.exists()
        ),
        None,
    )
    assert edge is not None, "The Windows acceptance job must have Edge installed"
    tab = uuid4().hex
    html = (
        (
            """<!doctype html><meta charset=utf-8><title>Native viewport test [A04:TAB]</title>
      <style>body{margin:0;background:#f5f6fa;height:2200px;font:18px sans-serif}
      #target{position:fixed;left:34%;top:42%;width:140px;height:80px;background:#ffd66a}
      h1{margin:25px}#pointer{position:fixed;left:10px;bottom:10px}</style>
      <h1>A04 native screen-coordinate check</h1><div id=target>Known AOI</div><div id=pointer></div>
      <script>window.moves=[];addEventListener('pointermove',e=>{moves.push({x:e.clientX,y:e.clientY,
      target:e.target.id});document.querySelector('#pointer').textContent=JSON.stringify(moves.at(-1))});</script>"""
        )
        .replace("TAB", tab)
        .encode()
    )

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tmp_path / "edge-profile"
    profile.mkdir()
    url = f"http://127.0.0.1:{server.server_port}/"
    process = subprocess.Popen(
        [
            str(edge),
            f"--user-data-dir={profile}",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=msEdgeSidebarV2",
            "--window-position=60,60",
            "--window-size=900,650",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    browser = None
    page = None
    evidence = {
        "hardware_tested": False,
        "reference": "Win32 physical cursor -> DOM pointer event",
        "cases": [],
    }
    try:
        active_port = profile / "DevToolsActivePort"

        async def port_ready():
            return (
                active_port.exists() and len(active_port.read_text().splitlines()) >= 2
            )

        await eventually(port_ready)
        port, browser_path = active_port.read_text().splitlines()[:2]
        browser_socket = await websockets.connect(
            f"ws://127.0.0.1:{port}{browser_path}"
        )
        browser = CDP(browser_socket)
        with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as response:
            targets = json.load(response)
        target = next(
            item
            for item in targets
            if item.get("type") == "page" and item.get("url", "").startswith(url)
        )
        async with websockets.connect(target["webSocketDebuggerUrl"]) as socket:
            page = CDP(socket)
            await page.call("Page.enable")
            await browser.call("Target.activateTarget", {"targetId": target["id"]})
            await eventually(
                lambda: page.evaluate(
                    "document.readyState === 'complete' && document.hasFocus()"
                )
            )
            window = await browser.call(
                "Browser.getWindowForTarget", {"targetId": target["id"]}
            )
            window_id = window["windowId"]
            provider = WindowsViewportProvider()
            assert provider.available, (
                "Native Windows API must be available in this job"
            )
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
            user32.SetCursorPos.restype = ctypes.c_bool
            user32.keybd_event.argtypes = [
                ctypes.c_ubyte,
                ctypes.c_ubyte,
                ctypes.c_uint,
                ctypes.c_size_t,
            ]

            async def metrics():
                return await page.evaluate(
                    "({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,screenW:screen.width,screenH:screen.height})"
                )

            async def observation():
                m = await metrics()
                try:
                    native = provider.observe(tab, {"w": m["w"], "h": m["h"]}, m["dpr"])
                    return native.to_wire("acceptance:1", tab)
                except ViewportError as error:
                    evidence["last_probe_error"] = str(error)
                    evidence["last_browser_metrics"] = m
                    return None

            async def verify(label):
                native = await eventually(observation)
                content, display, css = (
                    native["content"],
                    native["display"],
                    native["css"],
                )
                points = []
                # Targets near distinct corners plus an actual DOM AOI. This
                # detects translation, scale, border and toolbar mistakes.
                aoi = await page.evaluate(
                    "(()=>{let r=document.querySelector('#target').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()"
                )
                for x, y in [
                    (35, 90),
                    (css["w"] - 45, css["h"] - 45),
                    (aoi["x"], aoi["y"]),
                ]:
                    await page.evaluate("moves=[]")
                    px = round(content["x"] + x * native["dpr"])
                    py = round(content["y"] + y * native["dpr"])
                    assert user32.SetCursorPos(px + 3, py + 3)
                    await asyncio.sleep(0.03)
                    assert user32.SetCursorPos(px, py)
                    actual = await eventually(
                        lambda: page.evaluate("moves.at(-1)"),
                        lambda p: (
                            p is not None
                            and abs(p["x"] - x) <= 1.5
                            and abs(p["y"] - y) <= 1.5
                        ),
                    )
                    # Synthetic Tobii normalized-display data must round-trip
                    # to the same independently observed browser coordinate.
                    gaze = {
                        "x": (px - display["x"]) / display["w"],
                        "y": (py - display["y"]) / display["h"],
                    }
                    mapped_x = (
                        display["x"] + gaze["x"] * display["w"] - content["x"]
                    ) / native["dpr"]
                    mapped_y = (
                        display["y"] + gaze["y"] * display["h"] - content["y"]
                    ) / native["dpr"]
                    assert abs(mapped_x - actual["x"]) <= 0.01
                    assert abs(mapped_y - actual["y"]) <= 0.01
                    if (x, y) == (aoi["x"], aoi["y"]):
                        assert actual["target"] == "target"
                    points.append(
                        {"physical": [px, py], "gaze": gaze, "client": actual}
                    )
                evidence["cases"].append(
                    {"mode": label, "geometry": native, "points": points}
                )
                screenshot = await page.call(
                    "Page.captureScreenshot", {"format": "png"}
                )
                Path(f"native-viewport-{label}.png").write_bytes(
                    base64.b64decode(screenshot["data"])
                )
                return native

            # Fit the runner's actual screen; the lab's 1920x1080 is not assumed.
            m = await metrics()
            width, height = min(900, m["screenW"] - 120), min(650, m["screenH"] - 130)
            await browser.call(
                "Browser.setWindowBounds",
                {
                    "windowId": window_id,
                    "bounds": {"left": 40, "top": 40, "width": width, "height": height},
                },
            )
            await verify("windowed")
            await browser.call(
                "Browser.setWindowBounds",
                {
                    "windowId": window_id,
                    "bounds": {
                        "left": 80,
                        "top": 65,
                        "width": width - 90,
                        "height": height - 60,
                    },
                },
            )
            await verify("moved-resized")
            await page.evaluate("scrollTo(0, 350)")
            await verify("scrolled")
            # Real browser zoom, not CDP's pinch/visual-viewport emulation.
            original_dpr = (await metrics())["dpr"]
            assert provider.foreground_tab() == tab
            user32.keybd_event(0x11, 0, 0, 0)  # Ctrl
            for _ in range(2):
                user32.keybd_event(0x6B, 0, 0, 0)  # Numpad plus
                user32.keybd_event(0x6B, 0, 2, 0)
                await asyncio.sleep(0.1)
            user32.keybd_event(0x11, 0, 2, 0)
            await eventually(metrics, lambda value: value["dpr"] > original_dpr * 1.15)
            await verify("zoomed")
            user32.keybd_event(0x11, 0, 0, 0)
            user32.keybd_event(0x30, 0, 0, 0)  # Ctrl+0
            user32.keybd_event(0x30, 0, 2, 0)
            user32.keybd_event(0x11, 0, 2, 0)
            await eventually(metrics, lambda value: value["dpr"] == original_dpr)
            await browser.call(
                "Browser.setWindowBounds",
                {"windowId": window_id, "bounds": {"windowState": "maximized"}},
            )
            await verify("maximized")
            await page.evaluate("document.documentElement.requestFullscreen()")
            await eventually(
                lambda: page.evaluate("Boolean(document.fullscreenElement)")
            )
            native = await verify("fullscreen")
            # Native sampling is performed at120Hz. This bounds the average
            # overhead on the realWindowsAPI rather than timing a fake provider.
            start = time.perf_counter()
            for _ in range(240):
                provider.observe(tab, native["css"], native["dpr"])
            mean_ms = (time.perf_counter() - start) * 1000 / 240
            evidence["native_probe_mean_ms"] = mean_ms
            assert mean_ms < 8, f"Native probe too slow for120Hz: {mean_ms:.2f}ms"
            # A same-size browser with a different active title must not be
            # mistaken for the study page.
            await page.evaluate("document.title='Another tab'")
            await eventually(lambda: page.evaluate("document.title==='Another tab'"))

            async def native_title_changed():
                return provider.foreground_tab() != tab

            # Updating document.title schedules a separate native-caption update.
            await eventually(native_title_changed)
            with pytest.raises(ViewportError):
                provider.observe(tab, native["css"], native["dpr"])
    finally:
        Path("native-viewport-windows.json").write_text(
            json.dumps(evidence, indent=2), encoding="utf-8"
        )
        if page:
            try:
                screenshot = await page.call(
                    "Page.captureScreenshot", {"format": "png"}
                )
                Path("native-viewport-last.png").write_bytes(
                    base64.b64decode(screenshot["data"])
                )
            except Exception:
                pass
        if browser:
            try:
                await browser.call("Browser.close")
            except Exception:
                pass
            await browser.socket.close()
        server.shutdown()
        server.server_close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)


@pytest.mark.asyncio
async def test_real_edge_public_origin_loopback_permission_recovery(tmp_path):
    """HTTPS-to-loopback permission, absent from localhost-only geometry tests.

    The study-origin document is fulfilled locally by CDP. Every other page
    request except the mock bridge is blocked; this test cannot contact study
    APIs or create participant data. Browser permission is real, not mocked JS.
    """
    origin = "https://a04.rdm.lab.lrz.de"
    fixture_url = origin + "/__bridge_permission_test"
    bridge_http = "http://127.0.0.1:8766/"
    bridge_ws = "ws://127.0.0.1:8766"
    edge = next(
        (
            path
            for path in [
                Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)"))
                / "Microsoft/Edge/Application/msedge.exe",
                Path(os.environ.get("PROGRAMFILES", "C:/Program Files"))
                / "Microsoft/Edge/Application/msedge.exe",
            ]
            if path.exists()
        ),
        None,
    )
    assert edge is not None, "The Windows acceptance job must have Edge installed"
    tab = uuid4().hex
    html = """<!doctype html><meta charset="utf-8">
<title>A04 permission test [A04:TAB]</title>
<h1>Browser-to-bridge permission test</h1><button id="retry">Connect bridge</button>
<script>
window.permissionTest = {phase:'idle', socketAttempts:0};
window.permissionState = async () => {
  try { return (await navigator.permissions.query({name:'loopback-network'})).state }
  catch (error) { return 'unsupported:' + error.name }
};
window.fetchBridge = async () => {
  try {
    const response = await fetch('HTTP', {method:'GET', mode:'no-cors', credentials:'omit',
      redirect:'follow', cache:'no-store', targetAddressSpace:'loopback'});
    return {resolved:true, type:response.type, status:response.status};
  } catch (error) { return {resolved:false, error:error.name} }
};
window.socketBridge = () => new Promise(resolve => {
  permissionTest.socketAttempts++;
  const socket = new WebSocket('WS');
  let finished = false, status = null;
  const finish = result => {
    if (finished) return;
    finished = true; clearTimeout(timer); socket.close(); resolve(result);
  };
  const timer = setTimeout(() => finish({connected:false, error:'timeout'}), 5000);
  socket.onerror = () => finish({connected:false, error:'socket_error'});
  socket.onclose = () => finish({connected:false, error:'socket_closed'});
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'status') {
      status = message;
      socket.send(JSON.stringify({type:'viewport_probe',request_id:'permission-test',
        tab_id:'TAB',css:{w:innerWidth,h:innerHeight},dpr:devicePixelRatio}));
    } else if (message.type === 'viewport_status') {
      finish({connected:true,status,viewport:message});
    }
  };
});
document.querySelector('#retry').onclick = () => {
  window.permissionTest = {phase:'permission_pending',socketAttempts:0,started:performance.now()};
  void (async () => {
    permissionTest.fetch = await fetchBridge();
    permissionTest.fetchElapsed = performance.now() - permissionTest.started;
    permissionTest.phase = 'connecting';
    permissionTest.socket = await socketBridge();
    permissionTest.phase = permissionTest.socket.connected ? 'connected' : 'failed';
  })();
};
</script>""".replace("TAB", tab).replace("HTTP", bridge_http).replace("WS", bridge_ws)
    evidence = {
        "hardware_tested": False,
        "origin": origin,
        "document_intercepted": False,
        "document_interception_count": 0,
        "real_study_api_requests_allowed": 0,
        "bridge_mode": "mock",
        "cases": [],
        "blocked_requests": [],
        "allowed_loopback_requests": 0,
    }
    browser = None
    page = None
    process = None
    bridge = None
    permission_delay = None
    permission_paused = asyncio.Event()
    bridge_log = (tmp_path / "permission-bridge.log").open("w", encoding="utf-8")
    try:
        bridge = subprocess.Popen(
            [sys.executable, "tobii_bridge.py", "--mock", "--no-screen-recording"],
            cwd=Path(__file__).parent,
            stdout=bridge_log,
            stderr=subprocess.STDOUT,
        )

        async def bridge_ready():
            assert bridge.poll() is None, "The test mock bridge exited before startup"
            try:
                async with websockets.connect(bridge_ws, origin=origin, open_timeout=1) as ws:
                    status = json.loads(await asyncio.wait_for(ws.recv(), 2))
                    return status if status.get("type") == "status" else None
            except (OSError, TimeoutError):
                return None

        initial_status = await eventually(bridge_ready)
        assert initial_status["source_mode"] == "mock"
        assert initial_status["native_viewport"] is True

        def http_response_code():
            try:
                with urlopen(bridge_http, timeout=3) as response:
                    return response.status
            except HTTPError as error:
                return error.code

        evidence["bridge_http_status"] = await asyncio.to_thread(http_response_code)
        assert evidence["bridge_http_status"] == 426
        profile = tmp_path / "permission-edge-profile"
        profile.mkdir()
        process = subprocess.Popen(
            [
                str(edge),
                f"--user-data-dir={profile}",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--window-position=40,40",
                "--window-size=900,650",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        active_port = profile / "DevToolsActivePort"

        async def port_ready():
            return active_port.exists() and len(active_port.read_text().splitlines()) >= 2

        await eventually(port_ready)
        port, browser_path = active_port.read_text().splitlines()[:2]
        browser = CDP(await websockets.connect(f"ws://127.0.0.1:{port}{browser_path}"))
        evidence["browser"] = await browser.call("Browser.getVersion")
        with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as response:
            targets = json.load(response)
        target = next(item for item in targets if item.get("type") == "page")

        async def intercept(client, event):
            request_id = event["requestId"]
            url = event["request"]["url"]
            if url == fixture_url and event["resourceType"] == "Document":
                policy = (
                    "default-src 'none'; script-src 'unsafe-inline'; "
                    f"connect-src {bridge_http} {bridge_ws}; "
                    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
                )
                await client.call("Fetch.fulfillRequest", {
                    "requestId": request_id,
                    "responseCode": 200,
                    "responseHeaders": [
                        {"name": "Content-Type", "value": "text/html; charset=utf-8"},
                        {"name": "Cache-Control", "value": "no-store"},
                        {"name": "Content-Security-Policy", "value": policy},
                    ],
                    "body": base64.b64encode(html.encode()).decode(),
                })
                evidence["document_intercepted"] = True
                evidence["document_interception_count"] += 1
            elif url == bridge_http:
                evidence["allowed_loopback_requests"] += 1
                if permission_delay is not None:
                    permission_paused.set()
                    await permission_delay.wait()
                await client.call("Fetch.continueRequest", {"requestId": request_id})
            else:
                evidence["blocked_requests"].append(url)
                await client.call("Fetch.failRequest", {
                    "requestId": request_id, "errorReason": "BlockedByClient",
                })

        page = InterceptingCDP(
            await websockets.connect(target["webSocketDebuggerUrl"]), intercept
        )
        await page.call("Page.enable")
        await page.call("Runtime.enable")
        await page.call("Log.enable")
        await page.call("Fetch.enable", {"patterns": [{"urlPattern": "*"}]})
        evidence["navigation"] = await page.call("Page.navigate", {"url": fixture_url})

        async def document_state():
            state = await page.evaluate("""({
                script:typeof window.permissionState, title:document.title,
                url:location.href, ready:document.readyState, focused:document.hasFocus(),
                secure:isSecureContext, body:document.body?.innerText.slice(0,300)
            })""")
            evidence["last_document_state"] = state
            return state

        # Activating a target while navigation is still committing can leave
        # the second Edge window behind the runner console. First prove that
        # the fixture loaded, then explicitly activate its actual page window.
        await eventually(document_state, lambda value: value["script"] == "function"
                         and value["ready"] == "complete")
        await browser.call("Target.activateTarget", {"targetId": target["id"]})
        await page.call("Page.bringToFront")

        async def foreground_document():
            state = await document_state()
            if not state["focused"]:
                await page.call("Page.bringToFront")
            return state

        await eventually(foreground_document, lambda value: value["focused"])
        assert await page.evaluate("isSecureContext && location.origin") == origin
        initial_permission = await page.evaluate("permissionState()")
        evidence["initial_permission"] = initial_permission
        assert initial_permission in ("prompt", "granted", "denied"), (
            f"Edge lacks granular loopback permission: {initial_permission}; "
            f"browser={evidence['browser']}"
        )

        async def permission(setting):
            await browser.call("Browser.setPermission", {
                "permission": {"name": "loopback-network"},
                "setting": setting,
                "origin": origin,
            })
            return await eventually(
                lambda: page.evaluate("permissionState()"), lambda state: state == setting
            )

        await permission("denied")
        denied_fetch = await page.evaluate("fetchBridge()")
        denied_socket = await page.evaluate("socketBridge()")
        evidence["cases"].append({
            "permission": "denied", "fetch": denied_fetch, "socket": denied_socket,
        })
        assert denied_fetch["resolved"] is False, "Real HTTPS-to-loopback fetch was not gated"
        assert denied_socket["connected"] is False, "Real HTTPS-to-loopback WebSocket was not gated"

        await permission("granted")
        granted_fetch = await page.evaluate("fetchBridge()")
        granted_socket = await page.evaluate("socketBridge()")
        evidence["cases"].append({
            "permission": "granted", "fetch": granted_fetch, "socket": granted_socket,
        })
        assert granted_fetch == {"resolved": True, "type": "opaque", "status": 0}
        assert granted_socket["connected"] is True
        assert granted_socket["status"]["native_viewport"] is True
        assert granted_socket["status"]["source_mode"] == "mock"
        assert granted_socket["viewport"]["ok"] is True, granted_socket

        # A CDP ASK override can complete a permission request immediately. Reset
        # to the browser's real prompt state instead. Hold its HTTP request at
        # interception while the permission decision is delayed; this validates
        # the long wait without claiming to automate Edge's native prompt UI.
        await browser.call("Browser.resetPermissions")
        assert await page.evaluate("permissionState()") == "prompt"
        permission_delay = asyncio.Event()
        evidence["delayed_grant_method"] = "HTTP request held at interception before permission evaluation"
        # The same explicit click path used by the app waits for fetch permission
        # before starting a socket timeout. A human may take longer than 5 s.
        await page.evaluate("document.querySelector('#retry').click()")
        await asyncio.wait_for(permission_paused.wait(), timeout=5)
        await asyncio.sleep(6)
        pending = await page.evaluate("permissionTest")
        evidence["pending_after_six_seconds"] = pending
        assert pending["phase"] == "permission_pending", pending
        assert pending["socketAttempts"] == 0, pending
        await permission("granted")
        permission_delay.set()
        recovered = await eventually(
            lambda: page.evaluate("permissionTest"),
            lambda value: value["phase"] in ("connected", "failed"),
        )
        evidence["cases"].append({"permission": "delayed_grant", "result": recovered})
        assert recovered["phase"] == "connected", recovered
        assert recovered["fetchElapsed"] >= 5900
        assert recovered["socketAttempts"] == 1
        assert recovered["socket"]["viewport"]["ok"] is True
        assert not page.errors, page.errors
        evidence["result"] = "passed"
    finally:
        if permission_delay is not None:
            permission_delay.set()
        if page:
            evidence["interception_errors"] = page.errors
            evidence["runtime_events"] = page.runtime_events
            with contextlib.suppress(Exception):
                evidence["final_document_state"] = await page.evaluate("""({
                    script:typeof window.permissionState,title:document.title,
                    url:location.href,ready:document.readyState,focused:document.hasFocus(),
                    body:document.body?.innerText.slice(0,300)
                })""")
                screenshot = await page.call("Page.captureScreenshot", {"format": "png"})
                Path("native-viewport-permission-last.png").write_bytes(
                    base64.b64decode(screenshot["data"])
                )
        Path("native-viewport-permission-windows.json").write_text(
            json.dumps(evidence, indent=2), encoding="utf-8"
        )
        if page:
            with contextlib.suppress(Exception):
                await page.close()
        if browser:
            with contextlib.suppress(Exception):
                await browser.call("Browser.close")
            await browser.socket.close()
        for child in (process, bridge):
            if child is None:
                continue
            with contextlib.suppress(subprocess.TimeoutExpired):
                if child is bridge:
                    child.terminate()
                child.wait(timeout=5)
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
        bridge_log.close()
