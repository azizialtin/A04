"""Short-lived attachment links for the original media files."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings
from app.core.security import create_access_token
from app.models.researcher import Researcher
from app.models.screen_recording import ScreenRecording
from app.models.video import Video
from app.services.storage import screens_dir, videos_dir
from app.services.video_url import sign_blob_url

DOWNLOAD_SECONDS = 300


@dataclass(frozen=True)
class MediaArtifact:
    mode: str
    storage_path: str
    filename: str
    local_path: Path | None = None


def _filename(stem: str, extension: str) -> str:
    safe = re.sub(r"[^\w .-]", "_", stem).strip(" .")
    safe = safe.encode("utf-8")[:180].decode("utf-8", errors="ignore").rstrip(" .")
    return f"{safe or 'aufnahme'}{extension}"


def attachment(filename: str) -> str:
    fallback = filename.encode("ascii", "ignore").decode() or "download"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


def _local_file(root: Path, relative: Path) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file() or path.stat().st_size == 0:
        raise HTTPException(404, "The media file is unavailable.")
    return path


async def media_artifact(
    db: AsyncSession, kind: str, media_id: int, settings: Settings
) -> MediaArtifact:
    if kind == "video":
        video = await db.get(Video, media_id)
        if video is None or not video.gcp_filename:
            raise HTTPException(404, "Video file not found.")
        path = video.gcp_filename
        filename = _filename(f"stimulus-{video.id}-{video.title}", Path(path).suffix.lower())
        if settings.GCP_BUCKET_NAME:
            return MediaArtifact("gcs", path, filename)
        local = await run_in_threadpool(_local_file, videos_dir(), Path(path))
        return MediaArtifact("local", path, filename, local)

    if kind == "screen":
        screen = await db.get(ScreenRecording, media_id)
        if screen is None or screen.status != "stored" or not screen.storage_path:
            raise HTTPException(404, "That capture has no stored file.")
        path = screen.storage_path
        filename = _filename(
            f"{screen.participant_id}-video-{screen.video_id}-screen-{screen.id}-{screen.recorder}",
            Path(path).suffix.lower(),
        )
        if screen.storage_mode == "gcs":
            if not settings.GCP_BUCKET_NAME:
                raise HTTPException(503, "The recording's storage bucket is not configured.")
            return MediaArtifact("gcs", path, filename)
        if screen.storage_mode != "local":
            raise HTTPException(503, "The recording's storage mode is unavailable.")
        local = await run_in_threadpool(
            _local_file, screens_dir(), Path(screen.participant_id) / Path(path).name
        )
        return MediaArtifact("local", path, filename, local)

    raise HTTPException(404, "Unknown media type.")


def _cloud_url(artifact: MediaArtifact, settings: Settings) -> str:
    from google.api_core.exceptions import NotFound
    from google.cloud import storage

    blob = storage.Client().bucket(settings.GCP_BUCKET_NAME).blob(artifact.storage_path)
    try:
        blob.reload()
    except NotFound as exc:
        raise HTTPException(404, "The media file is unavailable.") from exc
    if not blob.size:
        raise HTTPException(404, "The media file is empty.")
    return sign_blob_url(
        blob, expiration=DOWNLOAD_SECONDS, response_disposition=attachment(artifact.filename)
    )


async def issue_download(
    db: AsyncSession,
    kind: str,
    media_id: int,
    admin: Researcher,
    settings: Settings,
    request: Request,
) -> dict[str, str]:
    artifact = await media_artifact(db, kind, media_id, settings)
    if artifact.mode == "gcs":
        try:
            url = await run_in_threadpool(_cloud_url, artifact, settings)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "Could not prepare the download.") from exc
    else:
        token = create_access_token(
            {
                "sub": admin.email,
                "ver": admin.token_version,
                "role": "media_download",
                "kind": kind,
                "media_id": media_id,
            },
            expires=timedelta(seconds=DOWNLOAD_SECONDS),
        )
        url = str(
            request.url_for("download_media", kind=kind, media_id=media_id).include_query_params(
                token=token
            )
        )
    return {"url": url, "filename": artifact.filename}
