from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from app.core.config import Settings, production_problems
from app.core.security import create_access_token, decode_token
from app.models.enums import PhaseType
from app.models.screen_recording import ScreenRecording
from app.models.video import Video
from app.services.video_url import resolve_screen_url, resolve_video_url


def local_settings(path):
    return Settings(
        _env_file=None,
        ENVIRONMENT="production",
        JWT_SECRET="x" * 40,
        STORAGE_BACKEND="persistent_local",
        LOCAL_STORAGE_ROOT=str(path),
        GCP_BUCKET_NAME="",
        GAZE_STORAGE_MODE="local",
        SCREEN_STORAGE_MODE="local",
    )


def test_local_production_requires_a_real_writable_mount(tmp_path, monkeypatch):
    settings = local_settings(tmp_path)
    assert any("mounted" in p for p in production_problems(settings))
    monkeypatch.setattr(Path, "is_mount", lambda self: self == tmp_path)
    assert production_problems(settings) == []
    monkeypatch.setattr("app.core.config.os.access", lambda *args: False)
    assert any("writable" in p for p in production_problems(settings))


@pytest.mark.parametrize("root", ["", "relative/uploads"])
def test_local_production_rejects_implicit_or_relative_storage(root):
    settings = local_settings(root)
    settings.LOCAL_STORAGE_ROOT = root
    assert any("absolute" in p for p in production_problems(settings))


def test_local_production_rejects_mixed_storage_and_placeholder(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "is_mount", lambda self: self == tmp_path)
    settings = local_settings(tmp_path)
    settings.GCP_BUCKET_NAME = "unintended-bucket"
    settings.GAZE_STORAGE_MODE = "gcs"
    settings.DEV_PLACEHOLDER_VIDEO_URL = "https://example.invalid/clip.mp4"
    assert len(production_problems(settings)) == 3


@pytest.fixture
async def local_media(db, seed_study, seed_participant, tmp_path, monkeypatch):
    settings = local_settings(tmp_path)
    monkeypatch.setattr("app.api.media_playback.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.storage.UPLOADS", tmp_path)
    video = Video(
        study_id=seed_study.id,
        title="Synthetic clip",
        phase_type=PhaseType.training,
        gcp_filename="fixture.mp4",
    )
    db.add(video)
    await db.flush()
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "fixture.mp4").write_bytes(b"0000ftypisom" + b"x" * 1000)
    folder = tmp_path / "screens" / seed_participant.id
    folder.mkdir(parents=True)
    screen = ScreenRecording(
        participant_id=seed_participant.id,
        video_id=video.id,
        status="stored",
        storage_mode="local",
        recorder="bridge",
    )
    db.add(screen)
    await db.flush()
    screen.storage_path = str(folder / f"{screen.id}.webm")
    Path(screen.storage_path).write_bytes(b"\x1a\x45\xdf\xa3" + b"y" * 1000)
    await db.flush()
    return video, screen, settings


@pytest.mark.parametrize("kind", ["video", "screen"])
async def test_private_playback_head_range_and_token_scope(client, local_media, kind):
    video, screen, settings = local_media
    url = (
        resolve_video_url(video, settings)
        if kind == "video"
        else resolve_screen_url(screen, settings)
    )
    assert url and url.startswith("/media/") and "/uploads/" not in url
    parsed = urlsplit(url)
    token = parse_qs(parsed.query)["token"][0]
    claims = decode_token(token)
    assert claims["role"] == "media_playback"
    response = await client.get(url, headers={"Range": "bytes=2-9"})
    assert response.status_code == 206
    assert len(response.content) == 8
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["cache-control"] == "private, no-store"
    head = await client.head(url)
    assert head.status_code == 200 and head.content == b""
    assert int(head.headers["content-length"]) > 1000
    assert (await client.get(parsed.path)).status_code == 422
    assert (await client.get(parsed.path + "?token=forged")).status_code == 401
    wrong = parsed.path.rsplit("/", 1)[0] + "/999999?token=" + token
    assert (await client.get(wrong)).status_code == 401
    assert (
        await client.get("/admin/studies", headers={"Authorization": "Bearer " + token})
    ).status_code == 401
    expired = create_access_token(
        {k: v for k, v in claims.items() if k != "exp"}, expires=timedelta(seconds=-1)
    )
    assert (await client.get(parsed.path + "?token=" + expired)).status_code == 401


async def test_deleted_and_escaped_media_cannot_be_served(client, local_media, tmp_path, db):
    video, screen, settings = local_media
    url = resolve_video_url(video, settings)
    assert url
    video.gcp_filename = "../outside.mp4"
    (tmp_path / "outside.mp4").write_bytes(b"private")
    await db.flush()
    assert (await client.get(url)).status_code == 404
    screen_url = resolve_screen_url(screen, settings)
    assert screen_url
    Path(screen.storage_path).unlink()
    assert (await client.get(screen_url)).status_code == 404


def test_production_never_mounts_public_upload_directories(tmp_path, monkeypatch):
    import runpy

    settings = local_settings(tmp_path)
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    namespace = runpy.run_path("main.py")
    assert not any(getattr(r, "path", "").startswith("/uploads") for r in namespace["app"].routes)


@pytest.mark.parametrize(
    ("path", "root", "expected"),
    [
        ("/api/admin/studies/1/videos", "/api", 204),
        ("/admin/studies/1/videos", "/api", 204),
        ("/api/screen/recordings/1/upload", "/api", 204),
        ("/api/auth/admin/login", "/api", 413),
        ("/api-other/admin/studies/1/videos", "/api", 413),
        ("/api/über", "/api", 413),
    ],
)
async def test_upload_body_limits_respect_proxy_root_path(path, root, expected):
    from app.core.middleware import BodySizeLimitMiddleware

    messages = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        messages.append(message)

    middleware = BodySizeLimitMiddleware(
        app,
        max_bytes=10,
        upload_paths=(b"/admin/studies/", b"/screen/recordings/"),
        upload_max_bytes=1000,
    )
    await middleware(
        {"type": "http", "path": path, "root_path": root, "headers": [(b"content-length", b"100")]},
        receive,
        send,
    )
    assert messages[0]["status"] == expected
