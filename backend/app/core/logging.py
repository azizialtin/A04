"""Structured JSON logging so Cloud Logging parses each line into fields."""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar

from pythonjsonlogger import jsonlogger

# Set per request by RequestIDMiddleware; attached to every log line.
request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_ctx: ContextVar[str | None] = ContextVar("user_id", default=None)


class _ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        record.user_id = user_id_ctx.get()
        return True


class _JsonFormatter(jsonlogger.JsonFormatter):
    def add_fields(self, log_record, record, message_dict):
        super().add_fields(log_record, record, message_dict)
        # levelname already matches Cloud Logging's severity vocabulary.
        log_record["severity"] = record.levelname
        log_record.setdefault("time", self.formatTime(record, self.datefmt))
        log_record.setdefault("logger", record.name)

        # Cloud Error Reporting groups ERROR entries by the stack trace it finds
        # in the message, so the traceback has to travel there rather than in a
        # field of its own.
        if record.exc_info:
            log_record["message"] = (
                f"{log_record.get('message', '')}\n{self.formatException(record.exc_info)}"
            )


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter("%(time)s %(severity)s %(logger)s %(message)s"))
    handler.addFilter(_ContextFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

    # These two are chatty enough to bury everything else.
    for noisy in ("uvicorn.access", "sqlalchemy.engine.Engine"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
