"""Keep empty pre-handshake probes distinct from actual bridge failures."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from websockets.exceptions import InvalidMessage


def _is_empty_http_probe(record: logging.LogRecord) -> bool:
    if (
        record.levelno != logging.ERROR
        or record.getMessage() != "opening handshake failed"
        or not record.exc_info
    ):
        return False
    error = record.exc_info[1]
    if (
        not isinstance(error, InvalidMessage)
        or str(error) != "did not receive a valid HTTP request"
    ):
        return False
    request_error = error.__cause__
    if not isinstance(request_error, EOFError) or str(request_error) != (
        "connection closed while reading HTTP request line"
    ):
        return False
    empty_line = request_error.__cause__
    return (
        isinstance(empty_line, EOFError)
        and str(empty_line) == "stream ends after 0 bytes, before end of line"
        and empty_line.__cause__ is None
    )


class IncompleteHandshakeFilter(logging.Filter):
    """Replace only the known empty-request traceback with a bounded notice.

    A browser denying loopback permission and a plain TCP health probe can both
    close before sending HTTP. This says nothing about tracker discovery. Other
    handshake/protocol errors retain their complete diagnostic information.
    """

    def __init__(
        self,
        *,
        interval_seconds: float = 30,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__()
        self._interval_seconds = interval_seconds
        self._clock = clock
        self._last_notice: float | None = None
        self._lock = threading.Lock()

    def filter(self, record: logging.LogRecord) -> bool:
        if not _is_empty_http_probe(record):
            return True
        with self._lock:
            now = self._clock()
            notify = (
                self._last_notice is None
                or now - self._last_notice >= self._interval_seconds
            )
            if notify:
                self._last_notice = now
        if notify:
            # Mutate this one known record rather than logging recursively from
            # a filter (newer Python versions suppress reentrant logger calls).
            record.levelno = logging.WARNING
            record.levelname = logging.getLevelName(logging.WARNING)
            record.msg = (
                "[bridge] A local connection closed before its WebSocket request arrived. "
                "This can be a harmless connection check or a browser loopback permission block. "
                "If the study cannot connect, check its local-network/loopback permission. "
                "This message does not diagnose the eye tracker; the bridge is still listening."
            )
            record.args = ()
            record.exc_info = None
            record.exc_text = None
            record.stack_info = None
            return True
        return False


def install_incomplete_handshake_filter(
    logger: logging.Logger,
) -> IncompleteHandshakeFilter:
    """Install once on the logger passed to ``websockets.serve(logger=...)``."""
    for existing in logger.filters:
        if isinstance(existing, IncompleteHandshakeFilter):
            return existing
    handler = IncompleteHandshakeFilter()
    logger.addFilter(handler)
    return handler
