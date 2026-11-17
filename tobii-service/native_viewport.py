"""Measure Chromium's content HWND in physical desktop pixels on Windows.

Never infer the toolbar height from outer/inner dimensions. Chromium maintains
Chrome_RenderWidgetHostHWND at the content bounds. A tab-specific title nonce,
foreground ownership and a CSS/DPR size check identify the requesting page.
No window titles, handles or application paths are sent to the browser.
"""

from __future__ import annotations

import contextlib
import ctypes
import math
import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass

TAB_ID = re.compile(r"[0-9a-f]{32}\Z")
TITLE_MARKER = re.compile(r"\[A04:([0-9a-f]{32})\]")
PROBE_LEASE_SECONDS = 2.0
MAX_REGISTERED_TABS = 32


class ViewportError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    def as_dict(self):
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


@dataclass(frozen=True)
class NativeObservation:
    display: Rect
    content: Rect
    css_w: float
    css_h: float
    dpr: float
    root_hwnd: int
    content_hwnd: int

    def to_wire(self, identifier: str, tab_id: str):
        return {
            "id": identifier,
            "tab_id": tab_id,
            "display": self.display.as_dict(),
            "content": self.content.as_dict(),
            "css": {"w": self.css_w, "h": self.css_h},
            "dpr": self.dpr,
        }


class WindowsViewportProvider:
    """Small synchronous native queries; no COM, browser extension or SDK calls."""

    def __init__(self):
        self.available = False
        if sys.platform != "win32":
            return
        try:
            from ctypes import wintypes

            self.wintypes = wintypes
            self.user32 = ctypes.WinDLL("user32", use_last_error=True)
            self.window_callback = ctypes.WINFUNCTYPE(
                wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
            )
            self.monitor_callback = ctypes.WINFUNCTYPE(
                wintypes.BOOL,
                wintypes.HANDLE,
                wintypes.HDC,
                ctypes.POINTER(wintypes.RECT),
                wintypes.LPARAM,
            )
            functions = {
                "SetThreadDpiAwarenessContext": ([ctypes.c_void_p], ctypes.c_void_p),
                "GetForegroundWindow": ([], wintypes.HWND),
                "GetWindowTextW": (
                    [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int],
                    ctypes.c_int,
                ),
                "GetClassNameW": (
                    [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int],
                    ctypes.c_int,
                ),
                "IsWindowVisible": ([wintypes.HWND], wintypes.BOOL),
                "IsIconic": ([wintypes.HWND], wintypes.BOOL),
                "GetAncestor": ([wintypes.HWND, wintypes.UINT], wintypes.HWND),
                "GetClientRect": (
                    [wintypes.HWND, ctypes.POINTER(wintypes.RECT)],
                    wintypes.BOOL,
                ),
                "ClientToScreen": (
                    [wintypes.HWND, ctypes.POINTER(wintypes.POINT)],
                    wintypes.BOOL,
                ),
                "EnumChildWindows": (
                    [wintypes.HWND, self.window_callback, wintypes.LPARAM],
                    wintypes.BOOL,
                ),
                "EnumDisplayMonitors": (
                    [
                        wintypes.HDC,
                        ctypes.POINTER(wintypes.RECT),
                        self.monitor_callback,
                        wintypes.LPARAM,
                    ],
                    wintypes.BOOL,
                ),
            }
            for name, (arguments, result) in functions.items():
                function = getattr(self.user32, name)
                function.argtypes, function.restype = arguments, result
            with self._physical_pixels():
                pass
            self.available = True
        except (AttributeError, OSError, ViewportError):
            self.available = False

    @contextlib.contextmanager
    def _physical_pixels(self):
        # Scoped to this thread: the SDK callback and asyncio's worker may be
        # different threads. Restore any host/library DPI context afterwards.
        previous = self.user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        if not previous:
            raise ViewportError("dpi_awareness_unavailable")
        try:
            yield
        finally:
            self.user32.SetThreadDpiAwarenessContext(previous)

    def _title_tab(self, root):
        title = ctypes.create_unicode_buffer(4096)
        self.user32.GetWindowTextW(root, title, len(title))
        matches = TITLE_MARKER.findall(title.value)
        return matches[0] if len(matches) == 1 else None

    def foreground_tab(self):
        if not self.available:
            return None
        with self._physical_pixels():
            root = self.user32.GetForegroundWindow()
            return self._title_tab(root) if root else None

    def _single_display(self):
        displays = []

        @self.monitor_callback
        def collect(_monitor, _dc, rectangle, _data):
            r = rectangle.contents
            displays.append(Rect(r.left, r.top, r.right - r.left, r.bottom - r.top))
            return True

        if not self.user32.EnumDisplayMonitors(None, None, collect, 0):
            raise ViewportError("display_unavailable")
        if len(displays) != 1:
            raise ViewportError("multiple_displays")
        display = displays[0]
        if not 0 < display.w <= 65536 or not 0 < display.h <= 65536:
            raise ViewportError("display_unavailable")
        return display

    def _content_rect(self, handle, root):
        if (
            not self.user32.IsWindowVisible(handle)
            or self.user32.GetAncestor(handle, 2) != root
        ):
            return None
        name = ctypes.create_unicode_buffer(256)
        self.user32.GetClassNameW(handle, name, len(name))
        if name.value != "Chrome_RenderWidgetHostHWND":
            return None
        bounds = self.wintypes.RECT()
        origin = self.wintypes.POINT()
        if not self.user32.GetClientRect(handle, ctypes.byref(bounds)):
            return None
        if not self.user32.ClientToScreen(handle, ctypes.byref(origin)):
            return None
        rectangle = Rect(
            origin.x, origin.y, bounds.right - bounds.left, bounds.bottom - bounds.top
        )
        return rectangle if rectangle.w > 0 and rectangle.h > 0 else None

    def observe(self, tab_id, css, dpr, cached=None):
        if not self.available:
            raise ViewportError("unsupported_platform")
        with self._physical_pixels():
            root = self.user32.GetForegroundWindow()
            if not root or self._title_tab(root) != tab_id:
                raise ViewportError("not_foreground")
            if self.user32.IsIconic(root) or not self.user32.IsWindowVisible(root):
                raise ViewportError("not_foreground")
            display = self._single_display()

            def matches(rect):
                return (
                    rect
                    and abs(rect.w - css["w"] * dpr) <= 2
                    and abs(rect.h - css["h"] * dpr) <= 2
                )

            # Samples take the fast path. Probe requests deliberately enumerate
            # afresh to ensure the candidate is still unique.
            content = None
            handle = None
            if cached is not None and cached.root_hwnd == root:
                candidate = self._content_rect(cached.content_hwnd, root)
                if candidate == cached.content and matches(candidate):
                    handle, content = cached.content_hwnd, candidate
            if content is None:
                candidates = []
                seen_content = []

                @self.window_callback
                def collect(child, _data):
                    rectangle = self._content_rect(child, root)
                    if rectangle:
                        seen_content.append(child)
                        if matches(rectangle):
                            candidates.append((child, rectangle))
                    return True

                self.user32.EnumChildWindows(root, collect, 0)
                if len(candidates) > 1:
                    raise ViewportError("viewport_ambiguous")
                if not candidates:
                    raise ViewportError(
                        "viewport_size_mismatch"
                        if seen_content
                        else "viewport_unavailable"
                    )
                handle, content = candidates[0]
            # A focus/tab change in the middle of native calls cannot certify
            # the earlier foreground window.
            if (
                self.user32.GetForegroundWindow() != root
                or self._title_tab(root) != tab_id
            ):
                raise ViewportError("not_foreground")
            return NativeObservation(
                display, content, css["w"], css["h"], dpr, root, handle
            )


@dataclass
class _Registration:
    owner: object
    css: dict
    dpr: float
    observation: NativeObservation | None = None
    identifier: str | None = None
    last_probe: float = float("-inf")


class ViewportRegistry:
    def __init__(self, provider=None, *, wall_time=time.time, monotonic=time.monotonic):
        self.provider = provider if provider is not None else WindowsViewportProvider()
        self.available = self.provider.available
        self._wall_time = wall_time
        self._monotonic = monotonic
        self._lock = threading.RLock()
        self._registrations = {}
        self._bridge_id = uuid.uuid4().hex
        self._generation = 0
        self._foreground = None

    def _now(self):
        return int(self._wall_time() * 1000)

    def _watch_foreground(self):
        active = self.provider.foreground_tab()
        if active != self._foreground:
            for entry in self._registrations.values():
                entry.identifier = None
            self._foreground = active
        return active

    def _new_id(self):
        self._generation += 1
        return f"{self._bridge_id}:{self._generation}"

    @staticmethod
    def _valid_number(value, low, high):
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and low <= value <= high
        )

    def probe(self, owner, message):
        request = message.get("request_id")
        tab = message.get("tab_id")
        reply = {
            "type": "viewport_status",
            "request_id": request
            if isinstance(request, str) and len(request) <= 128
            else None,
            "tab_id": tab if isinstance(tab, str) and TAB_ID.fullmatch(tab) else None,
            "ok": False,
            "observed_at": self._now(),
        }
        css, dpr = message.get("css"), message.get("dpr")
        if not (
            isinstance(request, str)
            and 0 < len(request) <= 128
            and isinstance(tab, str)
            and TAB_ID.fullmatch(tab)
            and isinstance(css, dict)
            and set(css) == {"w", "h"}
            and all(self._valid_number(css[key], 1, 32768) for key in ("w", "h"))
            and self._valid_number(dpr, 0.25, 8)
        ):
            return {**reply, "error_code": "invalid_probe"}
        if not self.available:
            return {**reply, "error_code": "unsupported_platform"}
        with self._lock:
            entry = self._registrations.get(tab)
            if entry is not None and entry.owner is not owner:
                return {**reply, "error_code": "tab_owned"}
            if entry is None:
                # One title nonce per geometry socket; rebinding revokes the
                # previous proof before it can be reused by another page.
                self.unregister(owner)
                if len(self._registrations) >= MAX_REGISTERED_TABS:
                    return {**reply, "error_code": "probe_limit"}
                entry = self._registrations[tab] = _Registration(owner, dict(css), dpr)
            if (
                entry.css != css
                or entry.dpr != dpr
                or self._monotonic() - entry.last_probe > PROBE_LEASE_SECONDS
            ):
                entry.identifier = None
            entry.css, entry.dpr = dict(css), dpr
            try:
                if self._watch_foreground() != tab:
                    raise ViewportError("not_foreground")
                observed = self.provider.observe(tab, css, dpr)
                if observed != entry.observation:
                    entry.identifier = None
                if entry.identifier is None:
                    entry.identifier = self._new_id()
                entry.observation = observed
                entry.last_probe = self._monotonic()
                return {
                    **reply,
                    "ok": True,
                    "observed_at": self._now(),
                    "native_viewport": observed.to_wire(entry.identifier, tab),
                }
            except Exception as exc:
                entry.identifier = None
                return {
                    **reply,
                    "observed_at": self._now(),
                    "error_code": exc.code
                    if isinstance(exc, ViewportError)
                    else "native_query_failed",
                }

    def sample_metadata(self):
        if not self.available:
            return {}
        empty = {"viewport_id": None, "viewport_ts": self._now()}
        # Native probes run on a worker. Never stall the SDK callback waiting
        # for a probe; a single uncertain sample is retained without a mapping.
        if not self._lock.acquire(blocking=False):
            return empty
        try:
            tab = self._watch_foreground()
            entry = self._registrations.get(tab)
            if entry is None or entry.identifier is None:
                return empty
            if self._monotonic() - entry.last_probe > PROBE_LEASE_SECONDS:
                entry.identifier = None
                return empty
            observed = self.provider.observe(
                tab, entry.css, entry.dpr, cached=entry.observation
            )
            if observed != entry.observation:
                entry.identifier = None
                entry.observation = observed
                return empty
            return {
                "viewport_id": entry.identifier,
                "viewport_ts": self._now(),
                "viewport_tab_id": tab,
            }
        except Exception:
            # Raw gaze must survive an unavailable HWND or failing native API.
            for entry in self._registrations.values():
                entry.identifier = None
            return empty
        finally:
            self._lock.release()

    def unregister(self, owner):
        with self._lock:
            for tab in [
                tab
                for tab, entry in self._registrations.items()
                if entry.owner is owner
            ]:
                del self._registrations[tab]


def sample_metadata(callback):
    """An optional native observer must never break or overwrite raw SDK gaze."""
    if callback is None:
        return {}
    try:
        value = callback()
        if not isinstance(value, dict):
            return {}
        return {
            key: value[key]
            for key in ("viewport_id", "viewport_ts", "viewport_tab_id")
            if key in value
        }
    except Exception:
        return {"viewport_id": None, "viewport_ts": int(time.time() * 1000)}
