"""Independent physical-pixel check using a real, headed Edge window on Windows.

Run explicitly with A04_NATIVE_VIEWPORT_WINDOWS_TEST=1. SetCursorPos moves the
actual Windows cursor; DOM pointer events provide the independent reference.
CDP mouse emulation would not establish the native screen/content offset.
No tracker is required and no research data or existing browser profile is used.
"""

from __future__ import annotations

import asyncio
import base64
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
                    px = round(content["x"] + x * content["w"] / css["w"])
                    py = round(content["y"] + y * content["h"] / css["h"])
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
                        (display["x"] + gaze["x"] * display["w"] - content["x"])
                        * css["w"]
                        / content["w"]
                    )
                    mapped_y = (
                        (display["y"] + gaze["y"] * display["h"] - content["y"])
                        * css["h"]
                        / content["h"]
                    )
                    assert abs(mapped_x - actual["x"]) <= 1.5
                    assert abs(mapped_y - actual["y"]) <= 1.5
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
