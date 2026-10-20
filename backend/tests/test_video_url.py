from types import SimpleNamespace
from unittest.mock import Mock, call

import google.auth
import pytest
from google.auth.transport import requests as google_requests
from google.cloud import storage

from app.models.video import Video
from app.services.video_url import resolve_screen_url, resolve_video_url, sign_blob_url


@pytest.fixture
def runtime_identity(monkeypatch):
    credentials = SimpleNamespace(
        service_account_email="runtime@example.iam.gserviceaccount.com",
        token="expired-token",
    )
    credentials.refresh = Mock(
        side_effect=lambda request: setattr(credentials, "token", "refreshed-token")
    )
    default = Mock(return_value=(credentials, "test-project"))
    request = Mock()
    monkeypatch.setattr(google.auth, "default", default)
    monkeypatch.setattr(google_requests, "Request", Mock(return_value=request))
    return credentials, default, request


def test_private_key_signing_does_not_load_runtime_credentials(runtime_identity):
    _, default, _ = runtime_identity
    blob = Mock()
    blob.generate_signed_url.return_value = "https://storage.test/private-signed"

    assert sign_blob_url(blob, expiration=90) == "https://storage.test/private-signed"

    blob.generate_signed_url.assert_called_once_with(version="v4", expiration=90, method="GET")
    default.assert_not_called()


def test_keyless_credentials_sign_with_refreshed_runtime_token(runtime_identity):
    credentials, default, request = runtime_identity
    blob = Mock()
    blob.generate_signed_url.side_effect = [
        AttributeError("Credentials have no private key"),
        "https://storage.test/iam-signed",
    ]

    assert sign_blob_url(blob, expiration=120) == "https://storage.test/iam-signed"

    default.assert_called_once_with()
    credentials.refresh.assert_called_once_with(request)
    assert blob.generate_signed_url.call_args_list == [
        call(version="v4", expiration=120, method="GET"),
        call(
            version="v4",
            expiration=120,
            method="GET",
            service_account_email=credentials.service_account_email,
            access_token="refreshed-token",
        ),
    ]


def test_keyless_credentials_without_signing_identity_fail_explicitly(runtime_identity):
    credentials, _, _ = runtime_identity
    del credentials.service_account_email
    missing_key = AttributeError("Credentials have no private key")
    blob = Mock()
    blob.generate_signed_url.side_effect = missing_key

    with pytest.raises(RuntimeError, match="no service account to sign as") as error:
        sign_blob_url(blob)

    assert error.value.__cause__ is missing_key
    assert blob.generate_signed_url.call_count == 1


def test_signing_errors_do_not_trigger_a_credentials_fallback(runtime_identity):
    _, default, _ = runtime_identity
    failure = PermissionError("Signing denied")
    blob = Mock()
    blob.generate_signed_url.side_effect = failure

    with pytest.raises(PermissionError) as error:
        sign_blob_url(blob)

    assert error.value is failure
    default.assert_not_called()


def test_iam_signing_errors_reach_the_caller(runtime_identity):
    failure = PermissionError("IAM signing denied")
    blob = Mock()
    blob.generate_signed_url.side_effect = [AttributeError("No private key"), failure]

    with pytest.raises(PermissionError) as error:
        sign_blob_url(blob)

    assert error.value is failure
    assert blob.generate_signed_url.call_count == 2


def test_failed_token_refresh_does_not_attempt_iam_signing(runtime_identity):
    credentials, _, _ = runtime_identity
    failure = RuntimeError("Token refresh failed")
    credentials.refresh.side_effect = failure
    blob = Mock()
    blob.generate_signed_url.side_effect = AttributeError("No private key")

    with pytest.raises(RuntimeError) as error:
        sign_blob_url(blob)

    assert error.value is failure
    assert blob.generate_signed_url.call_count == 1


@pytest.fixture
def cloud_storage(monkeypatch):
    blob = Mock()
    blob.generate_signed_url.return_value = "https://storage.test/signed"
    bucket = Mock()
    bucket.blob.return_value = blob
    client = Mock()
    client.bucket.return_value = bucket
    factory = Mock(return_value=client)
    monkeypatch.setattr(storage, "Client", factory)
    return factory, client, bucket, blob


@pytest.mark.parametrize(
    ("filename", "bucket_name", "placeholder", "expected"),
    [
        (None, "", "", None),
        (None, "", "https://dev.test/placeholder.mp4", "https://dev.test/placeholder.mp4"),
        (None, "production-bucket", "https://dev.test/placeholder.mp4", None),
        ("clip.mp4", "", "https://dev.test/placeholder.mp4", "/uploads/videos/clip.mp4"),
    ],
)
def test_missing_or_local_video_does_not_use_cloud_storage(
    cloud_storage, filename, bucket_name, placeholder, expected
):
    factory, _, _, _ = cloud_storage
    settings = SimpleNamespace(GCP_BUCKET_NAME=bucket_name, DEV_PLACEHOLDER_VIDEO_URL=placeholder)

    assert resolve_video_url(Video(gcp_filename=filename), settings) == expected

    factory.assert_not_called()


def test_cloud_video_uses_its_stored_object_name(cloud_storage):
    factory, client, bucket, blob = cloud_storage
    settings = SimpleNamespace(GCP_BUCKET_NAME="research-videos", DEV_PLACEHOLDER_VIDEO_URL="")
    video = Video(gcp_filename="videos/study-12/clip.mp4")

    assert resolve_video_url(video, settings) == "https://storage.test/signed"

    factory.assert_called_once_with()
    client.bucket.assert_called_once_with("research-videos")
    bucket.blob.assert_called_once_with("videos/study-12/clip.mp4")
    blob.generate_signed_url.assert_called_once_with(version="v4", expiration=3600, method="GET")


@pytest.mark.parametrize(
    ("status", "storage_path"),
    [("recording", "screens/run.webm"), ("failed", "screens/run.webm"), ("stored", None)],
)
def test_unavailable_screen_has_no_playable_url(cloud_storage, status, storage_path):
    factory, _, _, _ = cloud_storage
    recording = SimpleNamespace(status=status, storage_path=storage_path, storage_mode="gcs")

    assert resolve_screen_url(recording, SimpleNamespace(GCP_BUCKET_NAME="captures")) is None

    factory.assert_not_called()


@pytest.mark.parametrize("bucket_name", ["", "captures"])
def test_local_screen_uses_participant_and_filename_even_when_cloud_is_configured(
    cloud_storage, bucket_name
):
    factory, _, _, _ = cloud_storage
    recording = SimpleNamespace(
        status="stored",
        storage_mode="local",
        storage_path="/server/uploads/screens/T-001/capture.webm",
        participant_id="T-001",
    )

    assert resolve_screen_url(recording, SimpleNamespace(GCP_BUCKET_NAME=bucket_name)) == (
        "/uploads/screens/T-001/capture.webm"
    )

    factory.assert_not_called()


def test_cloud_screen_uses_recording_storage_path(cloud_storage):
    factory, client, bucket, blob = cloud_storage
    recording = SimpleNamespace(
        status="stored", storage_mode="gcs", storage_path="screens/T-001/capture.webm"
    )

    assert resolve_screen_url(recording, SimpleNamespace(GCP_BUCKET_NAME="captures")) == (
        "https://storage.test/signed"
    )

    factory.assert_called_once_with()
    client.bucket.assert_called_once_with("captures")
    bucket.blob.assert_called_once_with("screens/T-001/capture.webm")
    blob.generate_signed_url.assert_called_once_with(version="v4", expiration=3600, method="GET")


@pytest.mark.parametrize("kind", ["video", "screen"])
def test_cloud_url_resolution_propagates_signing_failure(cloud_storage, kind):
    _, _, _, blob = cloud_storage
    failure = PermissionError("Signing denied")
    blob.generate_signed_url.side_effect = failure
    settings = SimpleNamespace(GCP_BUCKET_NAME="captures", DEV_PLACEHOLDER_VIDEO_URL="")

    with pytest.raises(PermissionError) as error:
        if kind == "video":
            resolve_video_url(Video(gcp_filename="clip.mp4"), settings)
        else:
            recording = SimpleNamespace(
                status="stored", storage_mode="gcs", storage_path="screens/T-001/capture.webm"
            )
            resolve_screen_url(recording, settings)

    assert error.value is failure
