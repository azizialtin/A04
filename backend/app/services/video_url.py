"""Resolve a playable URL for a video: signed GCS in prod, local path in dev."""

from __future__ import annotations

from app.models.video import Video


def sign_blob_url(blob, expiration: int = 3600) -> str:
    """A V4 signed GET url for `blob`, signed whichever way the runtime allows.

    Locally the credentials carry a private key and sign on the spot. On Cloud
    Run they carry only a token, and the library raises rather than signing —
    so hand it the runtime service account and that token, which makes it sign
    through the IAM API instead. That path is why the deployment grants the
    service account `roles/iam.serviceAccountTokenCreator` on itself.
    """
    terms = {"version": "v4", "expiration": expiration, "method": "GET"}
    try:
        return blob.generate_signed_url(**terms)
    except AttributeError as exc:
        import google.auth
        from google.auth.transport import requests as google_requests

        credentials, _ = google.auth.default()
        credentials.refresh(google_requests.Request())
        # default() is typed as the base Credentials; the account being signed
        # as is only on the runtime-provided ones, and without it there is no
        # signing identity to name.
        signer = getattr(credentials, "service_account_email", None)
        if signer is None:
            raise RuntimeError(
                "No private key to sign with and no service account to sign as; "
                "GCS urls cannot be signed in this environment."
            ) from exc
        return blob.generate_signed_url(
            **terms,
            service_account_email=signer,
            access_token=credentials.token,
        )


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
        return sign_blob_url(blob)

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
        return sign_blob_url(blob)

    return f"/uploads/screens/{recording.participant_id}/{recording.id}.mp4"
