from __future__ import annotations

import asyncio
import logging
import uuid

import pytest
import websockets
from websockets.exceptions import InvalidMessage

from connection_logging import (
    IncompleteHandshakeFilter,
    install_incomplete_handshake_filter,
)


def handshake_error(*, count=0, request_line=True):
    root = EOFError(f"stream ends after {count} bytes, before end of line")
    middle = EOFError(
        "connection closed while reading HTTP request line"
        if request_line
        else "connection closed while reading HTTP headers"
    )
    middle.__cause__ = root
    error = InvalidMessage("did not receive a valid HTTP request")
    error.__cause__ = middle
    return error


def record(error=None, message="opening handshake failed", level=logging.ERROR):
    return logging.LogRecord(
        "bridge.test",
        level,
        __file__,
        1,
        message,
        (),
        (type(error), error, None) if error else None,
    )


def isolated_logger():
    logger = logging.getLogger(f"bridge.test.{uuid.uuid4().hex}")
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    received = []

    class Collect(logging.Handler):
        def emit(self, entry):
            received.append(entry)

    logger.addHandler(Collect())
    return logger, received


def test_replaces_only_empty_request_traceback_with_rate_limited_uncertain_notice():
    logger, received = isolated_logger()
    now = [0.0]
    filter_ = IncompleteHandshakeFilter(clock=lambda: now[0])
    logger.addFilter(filter_)
    for moment in (0, 5, 29, 30):
        now[0] = moment
        logger.handle(record(handshake_error()))
    assert len(received) == 2
    assert all(
        entry.levelno == logging.WARNING and entry.exc_info is None
        for entry in received
    )
    assert "can be" in received[0].getMessage()
    assert "harmless connection check" in received[0].getMessage()
    assert "permission" in received[0].getMessage()
    assert "does not diagnose the eye tracker" in received[0].getMessage()


@pytest.mark.parametrize(
    "entry",
    [
        record(handshake_error(count=1)),
        record(handshake_error(count=80)),
        record(handshake_error(request_line=False)),
        record(InvalidMessage("invalid HTTP request")),
        record(EOFError("stream ends after 0 bytes, before end of line")),
        record(RuntimeError("SDK subscription failed")),
        record(handshake_error(), message="connection handler failed"),
        record(handshake_error(), level=logging.WARNING),
        record(
            message="[bridge] refused a connection from origin 'https://wrong.invalid'"
        ),
        record(message="connection open", level=logging.INFO),
    ],
)
def test_preserves_every_other_error_origin_or_connection_record(entry):
    logger, received = isolated_logger()
    install_incomplete_handshake_filter(logger)
    logger.handle(entry)
    assert received == [entry]


def test_install_is_idempotent():
    logger, _ = isolated_logger()
    first = install_incomplete_handshake_filter(logger)
    assert install_incomplete_handshake_filter(logger) is first
    assert logger.filters == [first]


@pytest.mark.asyncio
async def test_real_empty_tcp_probe_does_not_prevent_subsequent_websocket():
    logger, received = isolated_logger()
    install_incomplete_handshake_filter(logger)

    async def handler(ws):
        await ws.send("healthy connection")

    async with websockets.serve(handler, "127.0.0.1", 0, logger=logger) as server:
        port = server.sockets[0].getsockname()[1]
        _, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.close()
        await writer.wait_closed()
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            assert await ws.recv() == "healthy connection"

    assert any(
        "closed before its WebSocket request" in row.getMessage() for row in received
    )
    assert not any(row.levelno >= logging.ERROR for row in received)
