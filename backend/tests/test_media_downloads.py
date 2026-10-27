from datetime import timedelta
from unittest.mock import MagicMock
from urllib.parse import parse_qs, urlparse

import pytest
from google.api_core.exceptions import NotFound

from app.core.config import Settings
from app.core.security import create_access_token, decode_token
from app.models.enums import PhaseType
from app.models.screen_recording import ScreenRecording
from app.models.video import Video


@pytest.fixture
async def media(db, seed_study, seed_participant, tmp_path, monkeypatch):
    settings = Settings(_env_file=None, GCP_BUCKET_NAME="", ENVIRONMENT="development")
    for module in ("app.api.admin.videos", "app.api.admin.gaze", "app.api.media_download"):
        monkeypatch.setattr(f"{module}.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.storage.UPLOADS", tmp_path)
    video = Video(
        study_id=seed_study.id,
        title='Königsland / "Fall"',
        phase_type=PhaseType.training,
        gcp_filename="stimulus.mp4",
    )
    db.add(video)
    await db.flush()
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "stimulus.mp4").write_bytes(b"stimulus-file")
    screens = []
    folder = tmp_path / "screens" / seed_participant.id
    folder.mkdir(parents=True)
    for content in (b"first-capture", b"second-capture"):
        screen = ScreenRecording(
            participant_id=seed_participant.id,
            video_id=video.id,
            status="stored",
            storage_mode="local",
            recorder="browser",
        )
        db.add(screen)
        await db.flush()
        path = folder / f"{screen.id}.webm"
        path.write_bytes(content)
        screen.storage_path = str(path)
        screens.append(screen)
    await db.flush()
    return video, screens, settings


async def test_video_attachment_is_scoped_and_streamed(client, media, admin_headers):
    video, _, _ = media
    response = await client.get(f"/admin/videos/{video.id}/download-url", headers=admin_headers)
    assert response.status_code == 200
    target = response.json()
    assert response.headers["cache-control"] == "no-store"
    assert "Königsland" in target["filename"]
    assert "/" not in target["filename"]
    token = parse_qs(urlparse(target["url"]).query)["token"][0]
    assert decode_token(token)["role"] == "media_download"
    download = await client.get(target["url"])
    assert download.status_code == 200
    assert download.content == b"stimulus-file"
    assert "attachment" in download.headers["content-disposition"]
    assert "filename*=UTF-8''" in download.headers["content-disposition"]
    assert download.headers["cache-control"] == "no-store"
    wrong_file = target["url"].replace(f"/video/{video.id}?", f"/video/{video.id + 1}?")
    assert (await client.get(wrong_file)).status_code == 401
    assert (
        await client.get("/admin/studies", headers={"Authorization": f"Bearer {token}"})
    ).status_code == 401


async def test_capture_download_keeps_exact_recording_and_own_storage_mode(
    client, media, admin_headers
):
    _, screens, settings = media
    settings.GCP_BUCKET_NAME = "another-deployment-bucket"
    for screen, expected in zip(screens, (b"first-capture", b"second-capture"), strict=True):
        response = await client.get(
            f"/admin/screen-recordings/{screen.id}/download-url", headers=admin_headers
        )
        assert response.status_code == 200
        assert f"screen-{screen.id}-browser.webm" in response.json()["filename"]
        assert (await client.get(response.json()["url"])).content == expected
    listing = await client.get("/admin/screen-recordings", headers=admin_headers)
    assert {item["id"] for item in listing.json()["items"]} == {s.id for s in screens}
    page = await client.get("/admin/screen-recordings?limit=1&offset=1", headers=admin_headers)
    assert page.json()["total"] == 2
    assert [item["id"] for item in page.json()["items"]] == [screens[0].id]


async def test_download_requires_admin_and_revocation_invalidates_link(
    client, media, admin_headers, participant_headers, seed_researcher, db
):
    video, _, _ = media
    endpoint = f"/admin/videos/{video.id}/download-url"
    assert (await client.get(endpoint)).status_code == 401
    assert (await client.get(endpoint, headers=participant_headers)).status_code == 401
    url = (await client.get(endpoint, headers=admin_headers)).json()["url"]
    seed_researcher.token_version += 1
    await db.flush()
    assert (await client.get(url)).status_code == 401


async def test_download_links_expire_and_deleted_files_fail(
    client, media, admin_headers, seed_researcher, db
):
    video, _, _ = media
    expired = create_access_token(
        {
            "sub": seed_researcher.email,
            "ver": seed_researcher.token_version,
            "role": "media_download",
            "kind": "video",
            "media_id": video.id,
        },
        expires=timedelta(seconds=-1),
    )
    assert (await client.get(f"/downloads/video/{video.id}?token={expired}")).status_code == 401
    url = (
        await client.get(f"/admin/videos/{video.id}/download-url", headers=admin_headers)
    ).json()["url"]
    video.gcp_filename = None
    await db.flush()
    assert (await client.get(url)).status_code == 404


async def test_missing_local_file_and_failed_capture_do_not_issue_links(
    client, media, admin_headers, db
):
    video, screens, _ = media
    video.gcp_filename = "missing.mp4"
    screens[0].status = "failed"
    await db.flush()
    assert (
        await client.get(f"/admin/videos/{video.id}/download-url", headers=admin_headers)
    ).status_code == 404
    assert (
        await client.get(
            f"/admin/screen-recordings/{screens[0].id}/download-url", headers=admin_headers
        )
    ).status_code == 404


async def test_cloud_attachment_checks_file_and_signs_disposition(
    client, media, admin_headers, monkeypatch
):
    video, _, settings = media
    settings.GCP_BUCKET_NAME = "test-bucket"
    storage = MagicMock()
    blob = storage.bucket.return_value.blob.return_value
    blob.size = 100
    blob.generate_signed_url.return_value = "https://storage.example/attachment"
    monkeypatch.setattr("google.cloud.storage.Client", lambda: storage)
    response = await client.get(f"/admin/videos/{video.id}/download-url", headers=admin_headers)
    assert response.status_code == 200
    assert response.json()["url"] == "https://storage.example/attachment"
    terms = blob.generate_signed_url.call_args.kwargs
    assert terms["expiration"] == 300
    assert terms["response_disposition"].startswith("attachment;")
    blob.reload.side_effect = NotFound("missing")
    assert (
        await client.get(f"/admin/videos/{video.id}/download-url", headers=admin_headers)
    ).status_code == 404


async def test_cloud_capture_uses_its_recorded_path_and_requires_configured_bucket(
    client, media, admin_headers, monkeypatch, db
):
    _, screens, settings = media
    screen = screens[0]
    screen.storage_mode = "gcs"
    screen.storage_path = f"screens/{screen.participant_id}/{screen.id}.webm"
    await db.flush()
    endpoint = f"/admin/screen-recordings/{screen.id}/download-url"
    assert (await client.get(endpoint, headers=admin_headers)).status_code == 503
    settings.GCP_BUCKET_NAME = "recording-bucket"
    storage = MagicMock()
    blob = storage.bucket.return_value.blob.return_value
    blob.size = 1234
    blob.generate_signed_url.return_value = "https://storage.example/capture"
    monkeypatch.setattr("google.cloud.storage.Client", lambda: storage)
    response = await client.get(endpoint, headers=admin_headers)
    assert response.status_code == 200
    storage.bucket.assert_called_once_with("recording-bucket")
    storage.bucket.return_value.blob.assert_called_once_with(screen.storage_path)


async def test_local_download_cannot_leave_uploads_directory(
    client, media, admin_headers, tmp_path, db
):
    video, _, _ = media
    outside = tmp_path / "private.mp4"
    outside.write_bytes(b"not-a-stimulus")
    video.gcp_filename = "../private.mp4"
    await db.flush()
    assert (
        await client.get(f"/admin/videos/{video.id}/download-url", headers=admin_headers)
    ).status_code == 404
