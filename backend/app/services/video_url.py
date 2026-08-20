"""Resolve a playable URL for a video: signed GCS in prod, local path in dev."""

from __future__ import annotations

from app.models.video import Video


def resolve_video_url(video: Video, settings) -> str | None:
    """Return a URL the browser can load, or None if there's no file yet.

    Raises if GCS signing fails so callers can turn that into a 503.
    """
    if not video.gcp_filename:
        if settings.DEV_PLACEHOLDER_VIDEO_URL and not settings.GCP_BUCKET_NAME:
            return settings.DEV_PLACEHOLDER_VIDEO_URL
        return None

    if settings.GCP_BUCKET_NAME:
        from google.cloud import storage

        blob = storage.Client().bucket(settings.GCP_BUCKET_NAME).blob(video.gcp_filename)
        return blob.generate_signed_url(version="v4", expiration=3600, method="GET")

    return f"/uploads/videos/{video.gcp_filename}"


def resolve_screen_url(recording, settings) -> str | None:
    """A playable URL for one screen capture, or None if its file never landed.

    Signed for an hour like a clip; a think-aloud is watched in one sitting.
    """
    if recording.status != "stored" or not recording.storage_path:
        return None

    if recording.storage_mode == "gcs" and settings.GCP_BUCKET_NAME:
        from google.cloud import storage

        blob = storage.Client().bucket(settings.GCP_BUCKET_NAME).blob(recording.storage_path)
        return blob.generate_signed_url(version="v4", expiration=3600, method="GET")

    return f"/uploads/screens/{recording.participant_id}/{recording.id}.mp4"
