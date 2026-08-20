"""HTTP middlewares, written as plain ASGI.

We avoid Starlette's BaseHTTPMiddleware on purpose: it runs each request inside
an anyio task group, which reparents the event loop and upsets asyncpg
connections (and the DB-backed tests) pinned to the outer loop.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import request_id_ctx

_UPLOAD_MAX_BYTES = 500 * 1024 * 1024  # room for video uploads


class RequestIDMiddleware:
    """Reuse an inbound X-Request-ID or mint one, expose it on the response,
    and stash it for the logger."""

    header = b"x-request-id"

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        rid = None
        for key, value in scope.get("headers", []):
            if key.lower() == self.header:
                rid = value.decode("latin-1")
                break
        rid = rid or uuid.uuid4().hex
        rid_bytes = rid.encode("latin-1")
        token = request_id_ctx.set(rid)

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    (k, v) for k, v in message.get("headers", []) if k.lower() != self.header
                ]
                headers.append((self.header, rid_bytes))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            request_id_ctx.reset(token)


class BodySizeLimitMiddleware:
    """Reject requests whose Content-Length is too large before reading the body.
    Anything under an *upload_paths* prefix is allowed a much bigger limit."""

    def __init__(
        self,
        app: ASGIApp,
        max_bytes: int,
        upload_paths: tuple[bytes, ...] = (),
        upload_max_bytes: int = _UPLOAD_MAX_BYTES,
    ) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.upload_paths = upload_paths
        self.upload_max_bytes = upload_max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "").encode("latin-1")
        limit = (
            self.upload_max_bytes
            if any(path.startswith(p) for p in self.upload_paths)
            else self.max_bytes
        )

        for key, value in scope.get("headers", []):
            if key.lower() == b"content-length":
                try:
                    if int(value.decode("latin-1")) > limit:
                        await _reject_413(send, limit)
                        return
                except ValueError:
                    pass
                break

        await self.app(scope, receive, send)


async def _reject_413(send: Send, limit: int) -> None:
    body = f'{{"detail":"Request body exceeds {limit} bytes."}}'.encode()
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


_SECURITY_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"strict-transport-security", b"max-age=63072000; includeSubDomains"),
    (b"permissions-policy", b"geolocation=(), microphone=()"),
)


class SecurityHeadersMiddleware:
    """Add baseline defensive headers, but never clobber ones a route already set."""

    def __init__(self, app: ASGIApp, extra: Iterable[tuple[bytes, bytes]] = ()) -> None:
        self.app = app
        self.headers = _SECURITY_HEADERS + tuple(extra)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                present = {k.lower() for k, _ in headers}
                headers.extend((k, v) for k, v in self.headers if k not in present)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, _send)


def client_ip(request: Request, trusted_hops: int = 1) -> str | None:
    """Originating client IP, honoring X-Forwarded-For from N trusted hops."""
    if trusted_hops <= 0:
        return request.client.host if request.client else None

    xff = request.headers.get("x-forwarded-for")
    if not xff:
        return request.client.host if request.client else None

    parts = [p.strip() for p in xff.split(",") if p.strip()]
    if len(parts) >= trusted_hops:
        return parts[-trusted_hops]
    return parts[0] if parts else None
