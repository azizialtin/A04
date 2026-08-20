"""The defences a research deployment needs: exports that cannot execute,
logins that cannot be walked, uploads that are what they claim, and sessions
that can actually be ended."""

import pytest
import pytest_asyncio

from app.api import auth
from app.core.security import create_access_token
from app.models.note import Note
from app.models.text_entry import TextEntry
from app.models.video import Video
from app.services import storage
from app.services.researchers import revoke_researcher_sessions, set_researcher_password

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 32
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 60


@pytest.fixture(autouse=True)
def uploads(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    return tmp_path


@pytest_asyncio.fixture
async def study_video(db, seed_study):
    v = Video(study_id=seed_study.id, title="V")
    db.add(v)
    await db.flush()
    return v


# --- exports ---------------------------------------------------------------


async def test_formula_text_is_defused_in_exports(
    client, db, seed_study, seed_participant, study_video, admin_headers
):
    db.add(
        Note(
            participant_id=seed_participant.id,
            video_id=study_video.id,
            video_time_seconds=1.0,
            text='=cmd|"/c calc"!A1',
        )
    )
    db.add(
        TextEntry(
            participant_id=seed_participant.id,
            video_id=study_video.id,
            kind="diagnosis",
            text="@SUM(1+9)*cmd",
        )
    )
    await db.flush()

    notes = await client.get(f"/admin/studies/{seed_study.id}/export/notes", headers=admin_headers)
    diagnoses = await client.get(
        f"/admin/studies/{seed_study.id}/export/diagnoses", headers=admin_headers
    )

    assert "'=cmd" in notes.text
    assert '"=cmd|""/c calc""!A1"' not in notes.text  # not left executable
    assert "'@SUM" in diagnoses.text


@pytest.mark.parametrize("lead", ["=", "+", "-", "@", "\t", "\r"])
async def test_every_formula_lead_is_escaped(
    client, db, seed_study, seed_participant, study_video, admin_headers, lead
):
    db.add(
        Note(
            participant_id=seed_participant.id,
            video_id=study_video.id,
            video_time_seconds=1.0,
            text=f"{lead}danger",
        )
    )
    await db.flush()

    body = (
        await client.get(f"/admin/studies/{seed_study.id}/export/notes", headers=admin_headers)
    ).text
    assert f"'{lead}danger" in body


async def test_ordinary_text_is_left_alone(
    client, db, seed_study, seed_participant, study_video, admin_headers
):
    db.add(
        Note(
            participant_id=seed_participant.id,
            video_id=study_video.id,
            video_time_seconds=1.0,
            text="Die Schleife läuft einmal zu oft",
        )
    )
    await db.flush()

    body = (
        await client.get(f"/admin/studies/{seed_study.id}/export/notes", headers=admin_headers)
    ).text
    assert "Die Schleife läuft einmal zu oft" in body
    assert "'Die" not in body


async def test_export_is_readable_as_utf8_in_excel(
    client, db, seed_study, seed_participant, study_video, admin_headers
):
    db.add(
        Note(
            participant_id=seed_participant.id,
            video_id=study_video.id,
            video_time_seconds=1.0,
            text="Größe",
        )
    )
    await db.flush()

    r = await client.get(f"/admin/studies/{seed_study.id}/export/notes", headers=admin_headers)
    assert r.content.startswith(b"\xef\xbb\xbf")  # BOM, or Excel reads it as latin-1


# --- login throttling ------------------------------------------------------


async def test_participant_login_is_throttled(client, seed_participant):
    limit = auth.participant_attempts.limit
    for _ in range(limit):
        r = await client.post("/auth/participant/login", json={"participant_id": "NOPE"})
        assert r.status_code == 401

    blocked = await client.post("/auth/participant/login", json={"participant_id": "NOPE"})
    assert blocked.status_code == 429

    # Even a correct id is refused while the window is open.
    real = await client.post(
        "/auth/participant/login", json={"participant_id": seed_participant.id}
    )
    assert real.status_code == 429


async def test_admin_login_is_throttled(client, seed_researcher):
    for _ in range(auth.admin_attempts.limit):
        await client.post(
            "/auth/admin/login", json={"email": "nobody@a04.test", "password": "wrong-guess-here"}
        )

    blocked = await client.post(
        "/auth/admin/login", json={"email": "nobody@a04.test", "password": "wrong-guess-here"}
    )
    assert blocked.status_code == 429


def test_the_limiter_does_not_grow_for_ever():
    from app.core.ratelimit import RateLimiter

    limiter = RateLimiter(limit=1000, window_seconds=0, max_keys=50)
    for i in range(500):
        limiter.check(f"10.0.0.{i}")

    assert len(limiter) <= 50


def test_the_limiter_lets_a_key_back_in_after_its_window():
    from app.core.ratelimit import RateLimiter

    limiter = RateLimiter(limit=1, window_seconds=0)
    limiter.check("10.0.0.1")
    limiter.check("10.0.0.1")  # window already elapsed, so no 429


# --- session revocation ----------------------------------------------------


async def test_revoking_sessions_invalidates_an_issued_token(
    client, db, seed_researcher, admin_headers
):
    assert (await client.get("/admin/studies", headers=admin_headers)).status_code == 200

    await revoke_researcher_sessions(db, seed_researcher.email)

    assert (await client.get("/admin/studies", headers=admin_headers)).status_code == 401


async def test_a_password_reset_ends_the_open_sessions(client, db, seed_researcher, admin_headers):
    await set_researcher_password(db, seed_researcher.email, "a-brand-new-password")

    assert (await client.get("/admin/studies", headers=admin_headers)).status_code == 401


async def test_a_new_login_works_after_revocation(client, db, seed_researcher):
    await revoke_researcher_sessions(db, seed_researcher.email)

    r = await client.post(
        "/auth/admin/login",
        json={"email": seed_researcher.email, "password": "testpassword12"},
    )
    assert r.status_code == 200

    fresh = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await client.get("/admin/studies", headers=fresh)).status_code == 200


async def test_a_forged_version_claim_is_refused(client, seed_researcher):
    token = create_access_token({"sub": seed_researcher.email, "role": "admin", "ver": 99})
    r = await client.get("/admin/studies", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


# --- upload validation -----------------------------------------------------


async def _upload(client, headers, study_id, name, content, content_type):
    return await client.post(
        f"/admin/studies/{study_id}/videos",
        data={"title": "Case"},
        files={"file": (name, content, content_type)},
        headers=headers,
    )


async def test_a_real_video_is_accepted(client, seed_study, admin_headers):
    for name, content, ctype in [
        ("clip.mp4", MP4, "video/mp4"),
        ("clip.webm", WEBM, "video/webm"),
        ("clip.mov", MP4, "video/quicktime"),
    ]:
        r = await _upload(client, admin_headers, seed_study.id, name, content, ctype)
        assert r.status_code == 201, name


async def test_html_dressed_as_a_video_is_refused(client, uploads, seed_study, admin_headers):
    r = await _upload(
        client, admin_headers, seed_study.id, "clip.mp4", b"<script>alert(1)</script>", "video/mp4"
    )
    assert r.status_code == 415
    # And nothing was left behind on the origin that serves /uploads/videos.
    assert list((uploads / "videos").glob("*")) == []


async def test_an_html_extension_is_refused(client, seed_study, admin_headers):
    r = await _upload(client, admin_headers, seed_study.id, "evil.html", MP4, "text/html")
    assert r.status_code == 415


async def test_a_wrong_content_type_is_refused(client, seed_study, admin_headers):
    r = await _upload(client, admin_headers, seed_study.id, "clip.mp4", MP4, "text/html")
    assert r.status_code == 415


async def test_an_empty_file_is_refused(client, seed_study, admin_headers):
    r = await _upload(client, admin_headers, seed_study.id, "clip.mp4", b"", "video/mp4")
    assert r.status_code == 415


def test_a_video_larger_than_the_cap_is_refused(tmp_path):
    import io

    from app.services.storage import UploadRejected, store_video

    oversized = io.BytesIO(MP4 + b"\x00" * 4096)
    with pytest.raises(UploadRejected, match="larger than"):
        store_video(oversized, tmp_path / "big.mp4", max_bytes=1024)

    assert not (tmp_path / "big.mp4").exists()  # no partial file left behind


def test_the_header_check_knows_the_containers_we_play():
    from app.services.storage import looks_like_video

    assert looks_like_video(MP4)
    assert looks_like_video(WEBM)
    assert not looks_like_video(b"<!DOCTYPE html><html>")
    assert not looks_like_video(b"GIF89a")
    assert not looks_like_video(b"")
