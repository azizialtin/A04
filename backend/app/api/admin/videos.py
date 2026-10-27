"""Case clips and the content that travels with them."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from uuid import uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel
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
from app.services.media_download import issue_download
from app.services.storage import (
    ALLOWED_VIDEO_EXTENSIONS,
    ALLOWED_VIDEO_TYPES,
    MAX_VIDEO_BYTES,
    UploadRejected,
    create_resumable_session,
    delete_gaze_recording,
    delete_screen_recording,
    delete_video_file,
    store_video,
    verify_uploaded_blob,
    videos_dir,
)

from ._common import _audit, _phase, _study_or_404, _video_out
from ._sequence import _gaze_owners, _screen_owners

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/videos/{video_id}/download-url")
async def video_download_url(
    video_id: int,
    request: Request,
    response: Response,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    response.headers["Cache-Control"] = "no-store"
    return await issue_download(db, "video", video_id, admin, get_settings(), request)


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


# What upload-url hands out, and so the only shape finalize will accept: a name
# this app minted. Without it, finalize would take any object in the bucket —
# including another study's clip, or a participant's screen capture.
_MINTED_NAME = re.compile(r"^[0-9a-f]{32}\.(?:mp4|m4v|mov|webm)$")


class VideoUploadUrlRequest(BaseModel):
    filename: str
    size_bytes: int
    content_type: str = "video/mp4"


class VideoUploadUrlResponse(BaseModel):
    """Where to put the clip: a resumable session, or back through the app."""

    mode: str
    object_name: str
    upload_url: str | None = None


class VideoFinalizeRequest(BaseModel):
    object_name: str
    title: str
    phase_type: str = "training"
    task_description: str = ""
    info_text: str = ""
    student_task_text: str = ""
    time_limit_seconds: int | None = None
    # Follow the study's default text rather than carrying one of its own.
    use_default_task: bool = False
    use_default_info: bool = False


def _checked_extension(filename: str | None, content_type: str | None) -> str:
    ext = Path(filename or "").suffix.lower() or ".mp4"
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_VIDEO_EXTENSIONS))
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"Videos must be one of: {allowed}.",
        )
    if content_type and content_type not in ALLOWED_VIDEO_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"{content_type} is not a video type we can play.",
        )
    return ext


async def _add_video(
    db: AsyncSession,
    study_id: int,
    *,
    title: str,
    phase,
    task_description: str,
    info_text: str,
    student_task_text: str,
    time_limit_seconds: int | None,
    stored_name: str,
    use_default_task: bool = False,
    use_default_info: bool = False,
) -> Video:
    video = Video(
        study_id=study_id,
        title=title,
        phase_type=phase,
        task_description=task_description,
        info_text=info_text,
        student_task_text=student_task_text,
        time_limit_seconds=time_limit_seconds,
        gcp_filename=stored_name,
        use_default_task=use_default_task,
        use_default_info=use_default_info,
    )
    db.add(video)
    await db.commit()
    await db.refresh(video)
    return video


@router.post("/studies/{study_id}/videos/upload-url", response_model=VideoUploadUrlResponse)
async def video_upload_url(
    study_id: int,
    body: VideoUploadUrlRequest,
    request: Request,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> VideoUploadUrlResponse:
    """Open an upload for a case clip.

    Against a bucket the browser sends the bytes straight there — a hosted app
    cannot be relied on to carry half a gigabyte — and comes back to `finalize`
    with the name it was handed here.
    """
    await _study_or_404(db, study_id)
    ext = _checked_extension(body.filename, body.content_type)
    settings = get_settings()
    stored_name = f"{uuid4().hex}{ext}"

    if not settings.GCP_BUCKET_NAME:
        return VideoUploadUrlResponse(mode="proxy", object_name=stored_name)

    if body.size_bytes <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "size_bytes is required.")
    if body.size_bytes > MAX_VIDEO_BYTES:
        limit = MAX_VIDEO_BYTES // (1024 * 1024)
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"A clip cannot be larger than {limit} MB.",
        )

    try:
        url = await run_in_threadpool(
            create_resumable_session,
            stored_name,
            body.content_type or "video/mp4",
            body.size_bytes,
            settings,
            request.headers.get("origin"),
        )
    except Exception as exc:
        logger.exception("could not open an upload session for a clip")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Could not start the upload."
        ) from exc
    return VideoUploadUrlResponse(mode="resumable", object_name=stored_name, upload_url=url)


@router.post(
    "/studies/{study_id}/videos/finalize",
    response_model=VideoResponse,
    status_code=status.HTTP_201_CREATED,
)
async def finalize_video(
    study_id: int,
    body: VideoFinalizeRequest,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    """The browser has put a clip in the bucket; check it and record it.

    The bytes did not pass through here, so the header check that used to happen
    on their way past happens against the stored object instead.
    """
    await _study_or_404(db, study_id)
    phase = _phase(body.phase_type)
    settings = get_settings()
    if not settings.GCP_BUCKET_NAME:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This deployment takes the file itself; post it instead."
        )
    if not _MINTED_NAME.match(body.object_name):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That is not an upload this app opened.")

    try:
        await run_in_threadpool(verify_uploaded_blob, body.object_name, MAX_VIDEO_BYTES, settings)
    except UploadRejected as exc:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(exc)) from exc
    except Exception as exc:
        logger.exception("could not confirm clip %s", body.object_name)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Could not confirm the upload."
        ) from exc

    video = await _add_video(
        db,
        study_id,
        title=body.title,
        phase=phase,
        task_description=body.task_description,
        info_text=body.info_text,
        student_task_text=body.student_task_text,
        time_limit_seconds=body.time_limit_seconds,
        stored_name=body.object_name,
        use_default_task=body.use_default_task,
        use_default_info=body.use_default_info,
    )
    _audit(background_tasks, admin, "video_uploaded", {"video_id": video.id})
    return _video_out(video)


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
    use_default_task: bool = Form(False),
    use_default_info: bool = Form(False),
    file: UploadFile = File(...),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    await _study_or_404(db, study_id)
    phase = _phase(phase_type)
    settings = get_settings()

    ext = _checked_extension(file.filename, file.content_type)

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

    video = await _add_video(
        db,
        study_id,
        title=title,
        phase=phase,
        task_description=task_description,
        info_text=info_text,
        student_task_text=student_task_text,
        time_limit_seconds=time_limit_seconds,
        stored_name=stored_name,
        use_default_task=use_default_task,
        use_default_info=use_default_info,
    )
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
            status.HTTP_409_CONFLICT, "Video is used in a participant sequence or a video set."
        ) from None

    settings = get_settings()
    for participant_id, recording_id in recordings:
        await run_in_threadpool(delete_gaze_recording, participant_id, recording_id, settings)
    for participant_id, screen_id in screens:
        await run_in_threadpool(delete_screen_recording, participant_id, screen_id, settings)
    await run_in_threadpool(delete_video_file, filename, settings)

    _audit(background_tasks, admin, "video_deleted", {"video_id": video_id})
    return {"status": "ok"}
