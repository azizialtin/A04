"""A04 backend entrypoint.

Local run:
    uvicorn main:app --reload --port 8030
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import router
from app.core.config import get_settings
from app.core.logging import configure_logging, request_id_ctx
from app.core.middleware import (
    BodySizeLimitMiddleware,
    RequestIDMiddleware,
    SecurityHeadersMiddleware,
)
from app.services.storage import MAX_VIDEO_BYTES, screens_dir, videos_dir

settings = get_settings()
configure_logging()
logger = logging.getLogger(__name__)

app = FastAPI(title="A04 API", version="0.1.0")

# add_middleware adds outermost-last, so the request travels:
# RequestID -> SecurityHeaders -> CORS -> BodySize -> route handler.
app.add_middleware(
    BodySizeLimitMiddleware,
    max_bytes=settings.MAX_REQUEST_BODY_BYTES,
    # Video uploads land under /admin/studies/{id}/videos; the bridge posts a
    # finished screen capture to /screen/recordings/{id}/upload. The trailing
    # slash keeps the small JSON route at /screen/recordings on the tight limit.
    upload_paths=(b"/admin/studies", b"/screen/recordings/"),
    # Has to clear the largest thing anyone is allowed to send, or the cap the
    # route enforces would never be the one that actually bites.
    upload_max_bytes=max(MAX_VIDEO_BYTES, settings.MAX_SCREEN_RECORDING_BYTES),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.FRONTEND_URL.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS", "PUT"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    # Content-Disposition carries the export filename; without exposing it the
    # browser hides it from the page and every download would be "events.csv".
    expose_headers=["X-Request-ID", "Content-Disposition"],
    max_age=600,
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestIDMiddleware)


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    """Log the traceback where the monitoring can see it, and hand the caller a
    reference rather than a stack trace.

    The request id is in the response and in the log line, so a participant can
    read it out to the study manager and the study manager can find it.
    """
    request_id = request_id_ctx.get()
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong on our side.", "request_id": request_id},
        headers={"X-Request-ID": request_id} if request_id else None,
    )


app.include_router(router)

# In dev we serve uploaded clips straight off disk; production uses signed GCS URLs.
if not settings.is_production:
    uploads = videos_dir()
    uploads.mkdir(parents=True, exist_ok=True)
    app.mount("/uploads/videos", StaticFiles(directory=str(uploads)), name="uploads")

    screens = screens_dir()
    screens.mkdir(parents=True, exist_ok=True)
    app.mount("/uploads/screens", StaticFiles(directory=str(screens)), name="screens")
