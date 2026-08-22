"""Removing the files behind a row.

Deleting a study, a video or a participant used to delete only the database
rows: the mp4 stayed on disk or in the bucket, and so did every gaze chunk. For
eye-tracking data that is the difference between honouring an erasure request
and only appearing to.

Everything here is best-effort and logged. The rows are already gone by the
time it runs, so a storage failure must not fail the request — but it must be
visible.
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

UPLOADS = Path(__file__).resolve().parents[2] / "uploads"

# Participant ids become directory names, so they are held to a charset that
# cannot escape the uploads tree.
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


# What a case clip is allowed to be. Anything else is either a mistake or an
# attempt to put a file of our choosing on the app's own origin — in dev the
# uploads folder is served straight back, so an .html here would be stored XSS.
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".m4v", ".mov", ".webm"}
ALLOWED_VIDEO_TYPES = {"video/mp4", "video/x-m4v", "video/quicktime", "video/webm"}

MAX_VIDEO_BYTES = 500 * 1024 * 1024
_READ_CHUNK = 1024 * 1024
# Enough to see a container's magic; GCS will serve just this range.
_HEADER_BYTES = 64


class UploadRejected(Exception):
    """The file is not something we will store; the caller turns it into a 4xx."""


def videos_dir() -> Path:
    return UPLOADS / "videos"


def looks_like_video(head: bytes) -> bool:
    """Check the container's own header rather than trusting the client.

    ISO base media (mp4/m4v/mov) puts `ftyp` at offset 4; Matroska and WebM
    start with the EBML magic.
    """
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return True
    return head.startswith(b"\x1a\x45\xdf\xa3")


def store_video(upload, dest: Path, max_bytes: int = MAX_VIDEO_BYTES) -> int:
    """Stream an upload to disk, checking its header first.

    Synchronous on purpose — the caller runs it in a threadpool. Reading the
    whole file into memory to hand it over would mean half a gigabyte of RSS
    per upload.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with dest.open("wb") as out:
            head = upload.read(_READ_CHUNK)
            if not head:
                raise UploadRejected("The file is empty.")
            if not looks_like_video(head):
                raise UploadRejected("That file is not a video we can play.")
            while head:
                written += len(head)
                if written > max_bytes:
                    raise UploadRejected(f"Video is larger than {max_bytes // (1024 * 1024)} MB.")
                out.write(head)
                head = upload.read(_READ_CHUNK)
    except Exception:
        dest.unlink(missing_ok=True)  # never leave a partial file behind
        raise
    return written


def gaze_dir() -> Path:
    return UPLOADS / "gaze"


def screens_dir() -> Path:
    return UPLOADS / "screens"


def screen_blob_name(participant_id: str, recording_id: int) -> str:
    return f"screens/{participant_id}/{recording_id}.mp4"


def upload_screen_recording(local: Path, participant_id: str, recording_id: int, settings) -> str:
    """Move a finished capture to wherever recordings live, and say where.

    Synchronous like `store_video` — a screen recording is hundreds of megabytes
    and the caller runs it in a threadpool.
    """
    name = screen_blob_name(participant_id, recording_id)
    if settings.SCREEN_STORAGE_MODE == "gcs":
        _bucket(settings).blob(name).upload_from_filename(str(local), content_type="video/mp4")
        return name

    dest = screens_dir() / participant_id / f"{recording_id}.mp4"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(local), dest)
    return str(dest)


def create_resumable_session(
    blob_name: str,
    content_type: str,
    size: int,
    settings,
    origin: str | None = None,
) -> str:
    """A one-shot URL the client can PUT `size` bytes to, straight into the bucket.

    Cloud Run will not carry a request body past 32 MiB and a case clip or a
    screen capture is several times that, so the bytes have to bypass the app
    entirely. The session is created with the runtime credentials — no signing
    key involved — names one object, and is pinned to one length, so GCS itself
    refuses a client that tries to send more than it declared.
    """
    blob = _bucket(settings).blob(blob_name)
    return blob.create_resumable_upload_session(content_type=content_type, size=size, origin=origin)


def verify_uploaded_blob(blob_name: str, max_bytes: int, settings) -> int:
    """Check what actually landed in the bucket, and bin it if it is not a video.

    The bytes no longer pass through the app, so the header check that used to
    happen on their way past has to happen here instead. Without it an upload
    token would be a licence to put a file of the holder's choosing in the
    bucket. Returns the stored size.
    """
    from google.api_core.exceptions import NotFound

    blob = _bucket(settings).blob(blob_name)
    try:
        blob.reload()
    except NotFound as exc:
        raise UploadRejected("No file was uploaded.") from exc

    try:
        size = blob.size or 0
        if size == 0:
            raise UploadRejected("The file is empty.")
        if size > max_bytes:
            raise UploadRejected(f"File is larger than {max_bytes // (1024 * 1024)} MB.")
        if not looks_like_video(blob.download_as_bytes(start=0, end=_HEADER_BYTES - 1)):
            raise UploadRejected("That file is not a video we can play.")
    except UploadRejected:
        # Never leave a rejected file sitting in the bucket.
        blob.delete()
        raise
    return size


def delete_screen_recording(participant_id: str, recording_id: int, settings) -> None:
    try:
        if settings.GCP_BUCKET_NAME and settings.SCREEN_STORAGE_MODE == "gcs":
            _bucket(settings).blob(screen_blob_name(participant_id, recording_id)).delete()
            return
        path = screens_dir() / participant_id / f"{recording_id}.mp4"
        if _inside(screens_dir(), path):
            path.unlink(missing_ok=True)
    except Exception:
        logger.exception("could not delete screen recording %s", recording_id)


def delete_participant_screens(participant_id: str, settings) -> None:
    """Every screen capture of this participant's session."""
    try:
        if settings.GCP_BUCKET_NAME and settings.SCREEN_STORAGE_MODE == "gcs":
            _delete_prefix(f"screens/{participant_id}/", settings)
            return
        folder = screens_dir() / participant_id
        if _inside(screens_dir(), folder) and folder.is_dir():
            shutil.rmtree(folder)
    except Exception:
        logger.exception("could not delete screen recordings for participant %s", participant_id)


def _bucket(settings):
    from google.cloud import storage

    return storage.Client().bucket(settings.GCP_BUCKET_NAME)


def _inside(root: Path, candidate: Path) -> bool:
    try:
        return candidate.resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def delete_video_file(filename: str | None, settings) -> None:
    if not filename:
        return
    try:
        if settings.GCP_BUCKET_NAME:
            _bucket(settings).blob(filename).delete()
        else:
            # .name so a stored path can never point outside the videos folder.
            (videos_dir() / Path(filename).name).unlink(missing_ok=True)
    except Exception:
        logger.exception("could not delete video file %s", filename)


def delete_gaze_recording(participant_id: str, recording_id: int, settings) -> None:
    """The chunk files for one recording."""
    try:
        if settings.GCP_BUCKET_NAME and settings.GAZE_STORAGE_MODE == "gcs":
            _delete_prefix(f"gaze/{participant_id}/{recording_id}/", settings)
            return
        folder = gaze_dir() / participant_id / str(recording_id)
        if _inside(gaze_dir(), folder) and folder.is_dir():
            shutil.rmtree(folder)
    except Exception:
        logger.exception("could not delete gaze chunks for recording %s", recording_id)


def delete_participant_gaze(participant_id: str, settings) -> None:
    """Everything this participant's eyes ever produced."""
    try:
        if settings.GCP_BUCKET_NAME and settings.GAZE_STORAGE_MODE == "gcs":
            _delete_prefix(f"gaze/{participant_id}/", settings)
            return
        folder = gaze_dir() / participant_id
        if _inside(gaze_dir(), folder) and folder.is_dir():
            shutil.rmtree(folder)
    except Exception:
        logger.exception("could not delete gaze data for participant %s", participant_id)


def _delete_prefix(prefix: str, settings) -> None:
    bucket = _bucket(settings)
    for blob in bucket.list_blobs(prefix=prefix):
        blob.delete()
