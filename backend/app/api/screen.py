"""Screen capture: the browser opens a recording, the bridge delivers the file.

The capture itself runs in the Tobii bridge on the lab machine, because that is
where the clock the gaze samples are stamped with lives. The bridge has no
session of its own, so the browser asks for a recording here, gets a token that
can do nothing but upload that one file, and hands it over the local socket.

Where the bytes go depends on the deployment. Against a bucket the bridge is
handed a resumable session and puts the file there itself, because a capture is
hundreds of megabytes and a hosted app cannot be relied on to carry a body that
size. On local storage it posts the file here as before. Either way the file is
checked before the row is allowed to say "stored".
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

import jwt
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_participant, oauth2_scheme
from app.core.security import create_access_token, decode_token
from app.models.participant import Participant
from app.models.screen_recording import ScreenRecording
from app.services.session_script import video_in_run
from app.services.storage import (
    UploadRejected,
    create_resumable_session,
    screen_blob_name,
    screen_extension,
    store_video,
    upload_screen_recording,
    verify_uploaded_blob,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/screen", tags=["screen"])

UPLOAD_ROLE = "screen_upload"


class StartRequest(BaseModel):
    video_id: int
    # Who is about to capture: the bridge's ffmpeg, or the page itself when no
    # bridge can. Recorded so an analysis can tell the two apart.
    recorder: Literal["bridge", "browser"] = "bridge"


class StartResponse(BaseModel):
    recording_id: int
    upload_token: str


class UploadUrlRequest(BaseModel):
    size_bytes: int
    content_type: str = "video/mp4"


class UploadUrlResponse(BaseModel):
    """Where the bridge should put the file.

    `resumable` carries a session url to PUT the bytes to; `proxy` means there
    is no bucket in this deployment and the file comes back through the app.
    """

    mode: str
    upload_url: str | None = None


class CompleteRequest(BaseModel):
    epoch_ms: int
    duration_ms: int = 0
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    # Has to match what `upload-url` was asked for: it names the object.
    content_type: str = "video/mp4"


class FailedRequest(BaseModel):
    error: str = ""


def _claims(token: str) -> dict:
    try:
        return decode_token(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from exc


def _upload_claims(token: str = Depends(oauth2_scheme)) -> dict:
    """A token that can upload one recording and do nothing else."""
    payload = _claims(token)
    if payload.get("role") != UPLOAD_ROLE:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid upload token")
    return payload


def _failure_claims(token: str = Depends(oauth2_scheme)) -> dict:
    """Who may say a capture failed: the participant whose session it is, or the
    bridge holding that recording's upload token.

    The bridge needs it because the failures that matter happen at the end —
    ffmpeg refusing to shut down, an upload the backend rejects — by which point
    the browser has moved on to the next screen and is not listening.
    """
    payload = _claims(token)
    if payload.get("role") not in (UPLOAD_ROLE, "participant"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    return payload


async def _open_recording(
    db: AsyncSession, recording_id: int, claims: dict, *, scoped: bool = True
) -> ScreenRecording:
    """The recording this token is allowed to finish, or the matching 4xx.

    `scoped` is off only for the failure report, whose token may be the
    participant's rather than one tied to a single recording.
    """
    if scoped and claims.get("rid") != recording_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That token is for a different recording.")

    recording = await db.get(ScreenRecording, recording_id)
    if recording is None or recording.participant_id != claims.get("sub"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found.")
    if recording.status == "stored":
        raise HTTPException(status.HTTP_409_CONFLICT, "That recording already has a file.")
    return recording


def _mark_stored(
    recording: ScreenRecording,
    *,
    storage_mode: str,
    path: str,
    size: int,
    epoch_ms: int,
    duration_ms: int,
    width: int | None,
    height: int | None,
    fps: float | None,
) -> None:
    recording.status = "stored"
    recording.storage_mode = storage_mode
    recording.storage_path = path
    recording.epoch_ms = epoch_ms
    recording.duration_ms = duration_ms or None
    recording.width = width
    recording.height = height
    recording.fps = fps
    recording.byte_size = size
    recording.completed_at = datetime.now(UTC)


def _direct_to_bucket(settings) -> bool:
    """Whether this deployment has a bucket the bridge can write to itself."""
    return bool(settings.SCREEN_STORAGE_MODE == "gcs" and settings.GCP_BUCKET_NAME)


@router.post("/recordings", response_model=StartResponse, status_code=status.HTTP_201_CREATED)
async def start_screen_recording(
    body: StartRequest,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> StartResponse:
    settings = get_settings()
    if not settings.SCREEN_RECORDING_ENABLED:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Screen recording is switched off.")
    if not await video_in_run(db, participant, body.video_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That video isn't part of your run.")

    recording = ScreenRecording(
        participant_id=participant.id,
        video_id=body.video_id,
        storage_mode=settings.SCREEN_STORAGE_MODE,
        recorder=body.recorder,
    )
    db.add(recording)
    await db.commit()
    await db.refresh(recording)

    token = create_access_token(
        {"sub": participant.id, "role": UPLOAD_ROLE, "rid": recording.id},
        expires=timedelta(hours=settings.SCREEN_UPLOAD_TOKEN_HOURS),
    )
    return StartResponse(recording_id=recording.id, upload_token=token)


@router.post("/recordings/{recording_id}/upload-url", response_model=UploadUrlResponse)
async def screen_upload_url(
    recording_id: int,
    body: UploadUrlRequest,
    request: Request,
    claims: dict = Depends(_upload_claims),
    db: AsyncSession = Depends(get_db),
) -> UploadUrlResponse:
    """Ask where to put the capture.

    The declared size is pinned into the session, so a client that sends more
    than it said is refused by GCS rather than by us noticing afterwards.
    """
    recording = await _open_recording(db, recording_id, claims)
    settings = get_settings()
    if not _direct_to_bucket(settings):
        return UploadUrlResponse(mode="proxy")

    if body.size_bytes <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "size_bytes is required.")
    if body.size_bytes > settings.MAX_SCREEN_RECORDING_BYTES:
        limit = settings.MAX_SCREEN_RECORDING_BYTES // (1024 * 1024)
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"A screen recording cannot be larger than {limit} MB.",
        )

    name = screen_blob_name(
        recording.participant_id, recording.id, screen_extension(body.content_type)
    )
    try:
        # The origin matters only when a browser is the uploader: the bucket
        # answers its CORS preflight with it. The bridge sends none.
        url = await run_in_threadpool(
            create_resumable_session,
            name,
            body.content_type or "video/mp4",
            body.size_bytes,
            settings,
            request.headers.get("origin"),
        )
    except Exception as exc:
        logger.exception("could not open an upload session for recording %d", recording_id)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Could not start the upload."
        ) from exc
    return UploadUrlResponse(mode="resumable", upload_url=url)


@router.post("/recordings/{recording_id}/complete")
async def complete_screen_recording(
    recording_id: int,
    body: CompleteRequest,
    claims: dict = Depends(_upload_claims),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """The bridge says the file is in the bucket; confirm it and close the row.

    The bytes never came past here, so this is the only place the file can be
    checked — that it arrived at all, that it is not oversized, and that it is
    really a video rather than whatever else the token holder fancied.
    """
    recording = await _open_recording(db, recording_id, claims)
    settings = get_settings()
    if not _direct_to_bucket(settings):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This deployment takes the file itself; post it instead."
        )
    if body.epoch_ms <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "epoch_ms is required.")

    name = screen_blob_name(
        recording.participant_id, recording.id, screen_extension(body.content_type)
    )
    try:
        size = await run_in_threadpool(
            verify_uploaded_blob, name, settings.MAX_SCREEN_RECORDING_BYTES, settings
        )
    except UploadRejected as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:
        logger.exception("could not confirm screen recording %d", recording_id)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Could not confirm the upload."
        ) from exc

    _mark_stored(
        recording,
        storage_mode="gcs",
        path=name,
        size=size,
        epoch_ms=body.epoch_ms,
        duration_ms=body.duration_ms,
        width=body.width,
        height=body.height,
        fps=body.fps,
    )
    await db.commit()
    return {"status": "ok", "bytes": size}


@router.post("/recordings/{recording_id}/upload")
async def upload_screen_recording_file(
    recording_id: int,
    file: UploadFile = File(...),
    epoch_ms: int = Form(...),
    duration_ms: int = Form(0),
    width: int | None = Form(None),
    height: int | None = Form(None),
    fps: float | None = Form(None),
    claims: dict = Depends(_upload_claims),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """Take the finished capture from the bridge, where there is no bucket.

    `epoch_ms` is the wall-clock time of video position 0 on the lab machine —
    the whole reason the recording is worth anything, since it is what lines the
    gaze samples up with the picture.
    """
    recording = await _open_recording(db, recording_id, claims)
    if epoch_ms <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "epoch_ms is required.")

    settings = get_settings()
    ext = screen_extension(file.content_type, file.filename)
    scratch = Path(tempfile.mkdtemp(prefix="a04-screen-upload-"))
    staged = scratch / f"screen{ext}"
    try:
        # Land it on disk first: the header check and the size cap both want the
        # bytes, and holding a gigabyte in memory to hand it to GCS is not on.
        written = await run_in_threadpool(
            store_video, file.file, staged, settings.MAX_SCREEN_RECORDING_BYTES
        )
        stored_path = await run_in_threadpool(
            upload_screen_recording,
            staged,
            recording.participant_id,
            recording.id,
            settings,
            ext,
        )
    except UploadRejected as exc:
        shutil.rmtree(scratch, ignore_errors=True)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:
        shutil.rmtree(scratch, ignore_errors=True)
        logger.exception("could not store screen recording %d", recording_id)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Failed to store the screen recording."
        ) from exc
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    _mark_stored(
        recording,
        storage_mode=settings.SCREEN_STORAGE_MODE,
        path=stored_path,
        size=written,
        epoch_ms=epoch_ms,
        duration_ms=duration_ms,
        width=width,
        height=height,
        fps=fps,
    )
    await db.commit()
    return {"status": "ok", "bytes": written}


@router.patch("/recordings/{recording_id}/failed")
async def mark_failed(
    recording_id: int,
    body: FailedRequest,
    claims: dict = Depends(_failure_claims),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """The bridge could not record, or could not finish. Said out loud rather
    than left as a row that looks like it is still going."""
    recording = await _open_recording(
        db, recording_id, claims, scoped=claims.get("role") == UPLOAD_ROLE
    )

    recording.status = "failed"
    recording.error = body.error[:500] or None
    recording.completed_at = datetime.now(UTC)
    await db.commit()
    logger.warning("screen recording %d failed: %s", recording_id, recording.error)
    return {"status": "ok"}
