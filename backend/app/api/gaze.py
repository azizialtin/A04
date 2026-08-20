"""Gaze capture + think-aloud replay. Everything here is participant-scoped."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_participant
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.participant import Participant
from app.models.screen_recording import ScreenRecording
from app.models.video import Video
from app.services.gaze_replay import compute_replay, compute_screen_replay
from app.services.session_script import video_in_run
from app.services.storage import gaze_dir
from app.services.video_url import resolve_screen_url, resolve_video_url

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/gaze",
    tags=["gaze"],
    dependencies=[Depends(get_current_participant)],
)


MAX_GEOMETRY_SNAPSHOTS = 200


class Size(BaseModel):
    w: float = Field(ge=0)
    h: float = Field(ge=0)


class Rect(BaseModel):
    x: float
    y: float
    w: float = Field(ge=0)
    h: float = Field(ge=0)


class WindowBox(BaseModel):
    x: float
    y: float
    outer_w: float = Field(ge=0)
    outer_h: float = Field(ge=0)
    inner_w: float = Field(ge=0)
    inner_h: float = Field(ge=0)


class GazeGeometry(BaseModel):
    """Where the clip sat on the screen, in CSS pixels, at time `ts`.

    The tracker reports gaze against the whole display, so this is what turns a
    sample into a position on the picture. Without it the data is unusable.
    """

    ts: int
    screen: Size
    window: WindowBox
    video: Rect
    frame: Size  # intrinsic video size, for the object-fit letterbox
    dpr: float = 1.0


class StartRecordingRequest(BaseModel):
    video_id: int
    sampling_rate_hz: float = Field(gt=0)
    geometry: GazeGeometry | None = None


class StartRecordingResponse(BaseModel):
    recording_id: int


class GazeSample(BaseModel):
    # Shared verbatim with the Tobii bridge. Coordinates are 0..1 top-left, or
    # null on blink / track-loss. ts is wall-clock ms.
    ts: int
    lx: float | None = None
    ly: float | None = None
    rx: float | None = None
    ry: float | None = None
    lv: bool | None = None
    rv: bool | None = None
    lpd: float | None = None
    rpd: float | None = None
    device_ts: int | None = None


class BatchSamplesRequest(BaseModel):
    samples: list[GazeSample] = Field(min_length=1)


class CompleteRecordingRequest(BaseModel):
    sample_count: int | None = None


class CalibrationPoint(BaseModel):
    """One validation target and where the participant actually looked, both in
    display coordinates. `offset` is the distance between them."""

    target_x: float
    target_y: float
    gaze_x: float | None = None
    gaze_y: float | None = None
    offset: float | None = None
    samples: int = 0


class CalibrationCreate(BaseModel):
    status: Literal["success", "failed", "skipped"]
    mean_offset: float | None = None
    mean_offset_degrees: float | None = None
    points: list[CalibrationPoint] = Field(default_factory=list, max_length=32)


class CalibrationResponse(BaseModel):
    id: int
    status: str
    mean_offset: float | None
    mean_offset_degrees: float | None


class ReplayPoint(BaseModel):
    t: int
    x: float
    y: float


class ReplayResponse(BaseModel):
    video_url: str
    # "screen" — the capture of the whole display, cursor and all, which is what
    # the think-aloud is for. "clip" — the stimulus on its own, the fallback for
    # a case whose capture failed.
    source: Literal["screen", "clip"] = "clip"
    sampling_rate_hz: int
    # plotted_points is what was captured; `points` is the thinned set the
    # player draws.
    plotted_points: int
    invalid_samples: int
    unmapped_samples: int
    offscreen_samples: int
    has_geometry: bool
    points: list[ReplayPoint]
    # Wall-clock ms at position 0, so the player can place anything else stamped
    # on that clock — the notes — onto the same timeline.
    epoch_ms: int | None = None
    duration_ms: int | None = None


async def _require_assigned(db: AsyncSession, participant: Participant, video_id: int) -> None:
    if not await video_in_run(db, participant, video_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That video isn't part of your run.")


async def _own_recording(
    db: AsyncSession, participant: Participant, recording_id: int
) -> GazeRecording:
    recording = await db.scalar(
        select(GazeRecording).where(
            GazeRecording.id == recording_id,
            GazeRecording.participant_id == participant.id,
        )
    )
    if recording is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found.")
    return recording


def _local_folder(recording: GazeRecording) -> Path:
    # backend/uploads/gaze/<participant>/<recording id>. Shares gaze_dir() with
    # the cleanup helpers so a delete always targets where a write went.
    return gaze_dir() / recording.participant_id / str(recording.id)


@router.post(
    "/recordings", response_model=StartRecordingResponse, status_code=status.HTTP_201_CREATED
)
async def start_recording(
    body: StartRecordingRequest,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> StartRecordingResponse:
    await _require_assigned(db, participant, body.video_id)
    settings = get_settings()
    recording = GazeRecording(
        participant_id=participant.id,
        video_id=body.video_id,
        sampling_rate_hz=int(body.sampling_rate_hz),
        storage_mode=settings.GAZE_STORAGE_MODE,
        geometry=[body.geometry.model_dump()] if body.geometry else [],
    )
    db.add(recording)
    await db.commit()
    await db.refresh(recording)
    return StartRecordingResponse(recording_id=recording.id)


@router.post(
    "/calibration", response_model=CalibrationResponse, status_code=status.HTTP_201_CREATED
)
async def record_calibration(
    body: CalibrationCreate,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> CalibrationResponse:
    """Store the outcome of a calibration and the validation that followed it."""
    calibration = GazeCalibration(
        participant_id=participant.id,
        status=body.status,
        mean_offset=body.mean_offset,
        mean_offset_degrees=body.mean_offset_degrees,
        points=[p.model_dump() for p in body.points],
    )
    db.add(calibration)
    await db.commit()
    await db.refresh(calibration)
    return CalibrationResponse(
        id=calibration.id,
        status=calibration.status,
        mean_offset=calibration.mean_offset,
        mean_offset_degrees=calibration.mean_offset_degrees,
    )


@router.get("/calibration", response_model=CalibrationResponse | None)
async def latest_calibration(
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> CalibrationResponse | None:
    """The most recent attempt, so a resumed run can skip a done calibration."""
    calibration = await db.scalar(
        select(GazeCalibration)
        .where(GazeCalibration.participant_id == participant.id)
        .order_by(GazeCalibration.created_at.desc(), GazeCalibration.id.desc())
    )
    if calibration is None:
        return None
    return CalibrationResponse(
        id=calibration.id,
        status=calibration.status,
        mean_offset=calibration.mean_offset,
        mean_offset_degrees=calibration.mean_offset_degrees,
    )


@router.post("/recordings/{recording_id}/geometry", status_code=status.HTTP_202_ACCEPTED)
async def add_geometry(
    recording_id: int,
    body: GazeGeometry,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Record a new screen layout mid-clip (a resize, entering fullscreen)."""
    recording = await _own_recording(db, participant, recording_id)
    if recording.completed_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Recording already finalised.")

    snapshots = list(recording.geometry or [])
    if len(snapshots) >= MAX_GEOMETRY_SNAPSHOTS:
        # Someone is dragging the window around; the newest layout is the one
        # that matters, so replace rather than grow without bound.
        snapshots[-1] = body.model_dump()
    else:
        snapshots.append(body.model_dump())
    # Reassign rather than mutate: SQLAlchemy does not track JSONB in place.
    recording.geometry = sorted(snapshots, key=lambda s: s["ts"])
    await db.commit()
    return {"snapshots": len(recording.geometry)}


@router.post("/recordings/{recording_id}/samples")
async def upload_samples(
    recording_id: int,
    body: BatchSamplesRequest,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    settings = get_settings()
    if len(body.samples) > settings.GAZE_BATCH_UPLOAD_MAX_SAMPLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Batch too large.")

    recording = await _own_recording(db, participant, recording_id)
    if recording.completed_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Recording already finalised.")

    # Claim this batch's slice of the recording in one statement. Reading the
    # count and writing it back separately let two uploads in flight pick the
    # same chunk name, and the second silently overwrote the first.
    claimed = await db.scalar(
        update(GazeRecording)
        .where(
            GazeRecording.id == recording_id,
            GazeRecording.completed_at.is_(None),
        )
        .values(sample_count=GazeRecording.sample_count + len(body.samples))
        .returning(GazeRecording.sample_count)
    )
    if claimed is None:
        # Finalised between the check above and here.
        raise HTTPException(status.HTTP_409_CONFLICT, "Recording already finalised.")

    offset = claimed - len(body.samples)
    ndjson = "\n".join(json.dumps(s.model_dump()) for s in body.samples) + "\n"
    # The offset is unique per batch because the row lock serialises the claim.
    chunk_name = f"chunk_{offset:09d}.ndjson"

    if settings.GAZE_STORAGE_MODE == "gcs":
        if not settings.GCP_BUCKET_NAME:
            logger.error("GAZE_STORAGE_MODE=gcs but no bucket configured")
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Gaze storage misconfigured.")
        prefix = f"gaze/{recording.participant_id}/{recording.id}/"
        try:
            from google.cloud import storage

            blob = storage.Client().bucket(settings.GCP_BUCKET_NAME).blob(prefix + chunk_name)
            blob.upload_from_string(ndjson, content_type="application/x-ndjson")
        except Exception as exc:
            logger.exception("failed to upload gaze chunk for recording %d", recording_id)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "Failed to store gaze data."
            ) from exc
        if not recording.storage_prefix:
            recording.storage_prefix = prefix
    else:
        folder = _local_folder(recording)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / chunk_name).write_text(ndjson)
        if not recording.storage_prefix:
            recording.storage_prefix = str(folder)

    # The count was already claimed above; commit it together with the prefix
    # so a failed write to storage rolls the claim back rather than leaving a
    # gap in the numbering.
    await db.commit()
    return {"status": "ok", "total_sample_count": claimed}


@router.patch("/recordings/{recording_id}/complete")
async def complete_recording(
    recording_id: int,
    body: CompleteRecordingRequest,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    recording = await _own_recording(db, participant, recording_id)
    if recording.completed_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Recording already finalised.")

    recording.completed_at = datetime.now(UTC)
    await db.commit()
    return {"status": "ok"}


@router.get("/videos/{video_id}/replay", response_model=ReplayResponse)
async def get_replay(
    video_id: int,
    participant: Participant = Depends(get_current_participant),
    db: AsyncSession = Depends(get_db),
) -> ReplayResponse:
    await _require_assigned(db, participant, video_id)
    video = await db.get(Video, video_id)
    if video is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Video not found.")

    settings = get_settings()
    recording = await db.scalar(
        select(GazeRecording)
        .where(GazeRecording.participant_id == participant.id, GazeRecording.video_id == video_id)
        .order_by(GazeRecording.started_at.desc())
    )

    # Prefer the screen capture: it holds the cursor, the notes box and the
    # timer as the participant actually saw them, and gaze lands on it without
    # any geometry to undo.
    screen = await db.scalar(
        select(ScreenRecording)
        .where(
            ScreenRecording.participant_id == participant.id,
            ScreenRecording.video_id == video_id,
            ScreenRecording.status == "stored",
            ScreenRecording.epoch_ms.is_not(None),
        )
        .order_by(ScreenRecording.started_at.desc())
    )
    if screen is not None:
        try:
            screen_url = resolve_screen_url(screen, settings)
        except Exception:
            logger.exception("could not sign screen recording %d", screen.id)
            screen_url = None
        if screen_url:
            data = await compute_screen_replay(recording, screen, settings)
            return ReplayResponse(
                video_url=screen_url,
                source="screen",
                sampling_rate_hz=recording.sampling_rate_hz if recording else 0,
                plotted_points=data["mapped_samples"],
                invalid_samples=data["invalid_samples"],
                unmapped_samples=data["unmapped_samples"],
                offscreen_samples=data["offscreen_samples"],
                has_geometry=data["has_geometry"],
                points=data["points"],
                epoch_ms=screen.epoch_ms,
                duration_ms=screen.duration_ms,
            )

    try:
        video_url = resolve_video_url(video, settings)
    except Exception:
        video_url = None

    if recording is None:
        return ReplayResponse(
            video_url=video_url or "",
            sampling_rate_hz=0,
            plotted_points=0,
            invalid_samples=0,
            unmapped_samples=0,
            offscreen_samples=0,
            has_geometry=False,
            points=[],
        )

    data = await compute_replay(db, recording, settings)
    return ReplayResponse(
        video_url=video_url or "",
        sampling_rate_hz=recording.sampling_rate_hz,
        plotted_points=data["mapped_samples"],
        invalid_samples=data["invalid_samples"],
        unmapped_samples=data["unmapped_samples"],
        offscreen_samples=data["offscreen_samples"],
        has_geometry=data["has_geometry"],
        points=data["points"],
    )
