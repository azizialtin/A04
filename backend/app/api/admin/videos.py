"""Case clips and the content that travels with them."""

from __future__ import annotations

import logging
from pathlib import Path
from uuid import uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.researcher import Researcher
from app.models.video import Video
from app.schemas.admin import VideoResponse, VideoUpdate
from app.services.storage import (
    ALLOWED_VIDEO_EXTENSIONS,
    ALLOWED_VIDEO_TYPES,
    UploadRejected,
    delete_gaze_recording,
    delete_screen_recording,
    delete_video_file,
    store_video,
    videos_dir,
)

from ._common import _audit, _phase, _study_or_404, _video_out
from ._sequence import _gaze_owners, _screen_owners

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/studies/{study_id}/videos", response_model=list[VideoResponse])
async def list_videos(
    study_id: int,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[VideoResponse]:
    await _study_or_404(db, study_id)
    rows = (
        (await db.execute(select(Video).where(Video.study_id == study_id).order_by(Video.id)))
        .scalars()
        .all()
    )
    return [_video_out(v) for v in rows]


@router.post(
    "/studies/{study_id}/videos", response_model=VideoResponse, status_code=status.HTTP_201_CREATED
)
async def upload_video(
    study_id: int,
    background_tasks: BackgroundTasks,
    title: str = Form(...),
    phase_type: str = Form("training"),
    task_description: str = Form(""),
    info_text: str = Form(""),
    student_task_text: str = Form(""),
    time_limit_seconds: int | None = Form(None),
    file: UploadFile = File(...),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    await _study_or_404(db, study_id)
    phase = _phase(phase_type)
    settings = get_settings()

    ext = Path(file.filename or "").suffix.lower() or ".mp4"
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"Videos must be one of: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}.",
        )
    if file.content_type and file.content_type not in ALLOWED_VIDEO_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"{file.content_type} is not a video type we can play.",
        )

    stored_name = f"{uuid4().hex}{ext}"
    # Written to disk first either way: streaming keeps a 500 MB clip out of
    # memory, and the header check needs the file open regardless.
    staged = videos_dir() / stored_name
    try:
        await run_in_threadpool(store_video, file.file, staged)
    except UploadRejected as exc:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(exc)) from exc

    if settings.GCP_BUCKET_NAME:
        try:
            from google.cloud import storage

            blob = storage.Client().bucket(settings.GCP_BUCKET_NAME).blob(stored_name)
            await run_in_threadpool(
                blob.upload_from_filename,
                str(staged),
                content_type=file.content_type or "video/mp4",
            )
        except Exception as exc:
            logger.exception("failed to upload video to bucket")
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "Failed to store video."
            ) from exc
        finally:
            staged.unlink(missing_ok=True)

    video = Video(
        study_id=study_id,
        title=title,
        phase_type=phase,
        task_description=task_description,
        info_text=info_text,
        student_task_text=student_task_text,
        time_limit_seconds=time_limit_seconds,
        gcp_filename=stored_name,
    )
    db.add(video)
    await db.commit()
    await db.refresh(video)
    _audit(background_tasks, admin, "video_uploaded", {"video_id": video.id})
    return _video_out(video)


@router.patch("/videos/{video_id}", response_model=VideoResponse)
async def update_video(
    video_id: int,
    body: VideoUpdate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    video = await db.get(Video, video_id)
    if video is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Video not found.")
    data = body.model_dump(exclude_unset=True)
    if data.get("phase_type") is not None:
        video.phase_type = _phase(data.pop("phase_type"))
    else:
        data.pop("phase_type", None)
    for field, value in data.items():
        setattr(video, field, value)
    await db.commit()
    await db.refresh(video)
    _audit(background_tasks, admin, "video_updated", {"video_id": video.id})
    return _video_out(video)


@router.delete("/videos/{video_id}")
async def delete_video(
    video_id: int,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    video = await db.get(Video, video_id)
    if video is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Video not found.")

    filename = video.gcp_filename
    recordings = await _gaze_owners(db, video_ids=[video_id])
    screens = await _screen_owners(db, video_ids=[video_id])
    try:
        await db.delete(video)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Video is used in a participant sequence."
        ) from None

    settings = get_settings()
    for participant_id, recording_id in recordings:
        await run_in_threadpool(delete_gaze_recording, participant_id, recording_id, settings)
    for participant_id, screen_id in screens:
        await run_in_threadpool(delete_screen_recording, participant_id, screen_id, settings)
    await run_in_threadpool(delete_video_file, filename, settings)

    _audit(background_tasks, admin, "video_deleted", {"video_id": video_id})
    return {"status": "ok"}
