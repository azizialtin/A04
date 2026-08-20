"""Screen capture: the browser opens a recording, the bridge delivers the file.

The capture itself runs in the Tobii bridge on the lab machine, because that is
where the clock the gaze samples are stamped with lives. The bridge has no
session of its own, so the browser asks for a recording here, gets a token that
can do nothing but upload that one file, and hands it over the local socket.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
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
from app.services.storage import UploadRejected, store_video, upload_screen_recording

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/screen", tags=["screen"])

UPLOAD_ROLE = "screen_upload"


class StartRequest(BaseModel):
    video_id: int


class StartResponse(BaseModel):
    recording_id: int
    upload_token: str


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
    )
    db.add(recording)
    await db.commit()
    await db.refresh(recording)

    token = create_access_token(
        {"sub": participant.id, "role": UPLOAD_ROLE, "rid": recording.id},
        expires=timedelta(hours=settings.SCREEN_UPLOAD_TOKEN_HOURS),
    )
    return StartResponse(recording_id=recording.id, upload_token=token)


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
    """Take the finished capture from the bridge.

    `epoch_ms` is the wall-clock time of video position 0 on the lab machine —
    the whole reason the recording is worth anything, since it is what lines the
    gaze samples up with the picture.
    """
    if claims.get("rid") != recording_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That token is for a different recording.")

    recording = await db.get(ScreenRecording, recording_id)
    if recording is None or recording.participant_id != claims.get("sub"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found.")
    if recording.status == "stored":
        raise HTTPException(status.HTTP_409_CONFLICT, "That recording already has a file.")
    if epoch_ms <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "epoch_ms is required.")

    settings = get_settings()
    scratch = Path(tempfile.mkdtemp(prefix="a04-screen-upload-"))
    staged = scratch / "screen.mp4"
    try:
        # Land it on disk first: the header check and the size cap both want the
        # bytes, and holding a gigabyte in memory to hand it to GCS is not on.
        written = await run_in_threadpool(
            store_video, file.file, staged, settings.MAX_SCREEN_RECORDING_BYTES
        )
        stored_path = await run_in_threadpool(
            upload_screen_recording, staged, recording.participant_id, recording.id, settings
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

    recording.status = "stored"
    recording.storage_mode = settings.SCREEN_STORAGE_MODE
    recording.storage_path = stored_path
    recording.epoch_ms = epoch_ms
    recording.duration_ms = duration_ms or None
    recording.width = width
    recording.height = height
    recording.fps = fps
    recording.byte_size = written
    recording.completed_at = datetime.now(UTC)
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
    if claims.get("role") == UPLOAD_ROLE and claims.get("rid") != recording_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That token is for a different recording.")

    recording = await db.get(ScreenRecording, recording_id)
    if recording is None or recording.participant_id != claims.get("sub"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found.")
    if recording.status == "stored":
        raise HTTPException(status.HTTP_409_CONFLICT, "That recording already has a file.")

    recording.status = "failed"
    recording.error = body.error[:500] or None
    recording.completed_at = datetime.now(UTC)
    await db.commit()
    logger.warning("screen recording %d failed: %s", recording_id, recording.error)
    return {"status": "ok"}
