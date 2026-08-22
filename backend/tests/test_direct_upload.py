"""Uploads that go straight to the bucket instead of through the app.

A screen capture is hundreds of megabytes and a case clip can be half a
gigabyte; a hosted backend will not carry a body that size. So the client asks
where to put the file, PUTs it to the bucket itself, and comes back to be told
whether what landed is acceptable. These tests cover that second half — the part
that decides whether an upload token can be turned into an arbitrary file in the
bucket.
"""

from __future__ import annotations

import struct

import pytest
import pytest_asyncio

from app.core.config import get_settings
from app.models.enums import ParticipantStatus, PhaseType
from app.models.participant_video import ParticipantVideo
from app.models.screen_recording import ScreenRecording
from app.models.session import Session
from app.models.video import Video
from app.services import storage
from app.services.storage import UploadRejected

EPOCH = 1_700_000_000_000
SESSION_URL = "https://storage.googleapis.com/upload/session/abc123"


def _mp4(size: int = 2048) -> bytes:
    return struct.pack(">I", 24) + b"ftypisom" + b"\0" * (size - 12)


@pytest.fixture
def bucket(monkeypatch):
    """A deployment that has somewhere to send the bytes."""
    settings = get_settings()
    monkeypatch.setattr(settings, "GCP_BUCKET_NAME", "a04-test-bucket", raising=False)
    monkeypatch.setattr(settings, "SCREEN_STORAGE_MODE", "gcs", raising=False)
    return settings


@pytest.fixture
def sessions(monkeypatch):
    """Record what session would have been opened, without opening one."""
    opened: list[tuple] = []

    def fake(blob_name, content_type, size, settings, origin=None):
        opened.append((blob_name, content_type, size, origin))
        return SESSION_URL

    monkeypatch.setattr("app.api.screen.create_resumable_session", fake)
    monkeypatch.setattr("app.api.admin.videos.create_resumable_session", fake)
    return opened


@pytest.fixture
def landed(monkeypatch):
    """Stand in for the object the client claims to have uploaded."""
    state: dict = {"size": 4096, "error": None, "checked": []}

    def fake(blob_name, max_bytes, settings):
        state["checked"].append((blob_name, max_bytes))
        if state["error"]:
            raise state["error"]
        return state["size"]

    monkeypatch.setattr("app.api.screen.verify_uploaded_blob", fake)
    monkeypatch.setattr("app.api.admin.videos.verify_uploaded_blob", fake)
    return state


@pytest_asyncio.fixture
async def assigned_video(db, seed_study, seed_participant):
    v = Video(
        study_id=seed_study.id, title="V", phase_type=PhaseType.pre_test, gcp_filename="v.mp4"
    )
    db.add(v)
    await db.flush()
    db.add(
        ParticipantVideo(
            participant_id=seed_participant.id,
            video_id=v.id,
            slot_index=0,
            phase_type=PhaseType.pre_test,
        )
    )
    seed_participant.status = ParticipantStatus.active
    db.add(Session(participant_id=seed_participant.id))
    await db.flush()
    return v


async def _open(client, headers, video_id):
    r = await client.post("/screen/recordings", json={"video_id": video_id}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["recording_id"], r.json()["upload_token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


async def _ask(client, recording_id, token, size=4096):
    return await client.post(
        f"/screen/recordings/{recording_id}/upload-url",
        headers=_auth(token),
        json={"size_bytes": size},
    )


async def _complete(client, recording_id, token, **over):
    body = {"epoch_ms": EPOCH, "duration_ms": 60_000, "width": 1920, "height": 1080, "fps": 30.0}
    body.update(over)
    return await client.post(
        f"/screen/recordings/{recording_id}/complete", headers=_auth(token), json=body
    )


# --- the screen capture ---------------------------------------------------


async def test_without_a_bucket_the_bridge_is_told_to_post_the_file(
    client, assigned_video, participant_headers
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    r = await _ask(client, recording_id, token)
    assert r.status_code == 200, r.text
    assert r.json()["mode"] == "proxy"
    assert r.json()["upload_url"] is None


async def test_with_a_bucket_the_bridge_gets_a_session_for_its_own_object(
    client, assigned_video, participant_headers, bucket, sessions
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    r = await _ask(client, recording_id, token, size=123_456)
    assert r.status_code == 200, r.text
    assert r.json() == {"mode": "resumable", "upload_url": SESSION_URL}

    # The object is named from the recording, never from anything the client sent.
    blob_name, content_type, size, _origin = sessions[0]
    assert blob_name == f"screens/T-001/{recording_id}.mp4"
    assert content_type == "video/mp4"
    # The declared length is pinned into the session, so GCS refuses a longer body.
    assert size == 123_456


async def test_a_capture_over_the_cap_is_refused_before_a_byte_moves(
    client, assigned_video, participant_headers, bucket, sessions
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    r = await _ask(client, recording_id, token, size=get_settings().MAX_SCREEN_RECORDING_BYTES + 1)
    assert r.status_code == 413
    assert sessions == []


async def test_a_session_needs_a_declared_size(
    client, assigned_video, participant_headers, bucket, sessions
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    assert (await _ask(client, recording_id, token, size=0)).status_code == 400
    assert sessions == []


async def test_completing_stores_the_size_the_bucket_reports(
    client, db, assigned_video, participant_headers, bucket, landed
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    landed["size"] = 7_654_321

    r = await _complete(client, recording_id, token)
    assert r.status_code == 200, r.text
    assert r.json()["bytes"] == 7_654_321

    row = await db.get(ScreenRecording, recording_id)
    await db.refresh(row)
    assert row.status == "stored"
    assert row.storage_mode == "gcs"
    assert row.storage_path == f"screens/T-001/{recording_id}.mp4"
    assert row.byte_size == 7_654_321
    assert row.epoch_ms == EPOCH
    # The size is taken from the bucket, never from what the client claimed.
    assert landed["checked"] == [
        (f"screens/T-001/{recording_id}.mp4", get_settings().MAX_SCREEN_RECORDING_BYTES)
    ]


async def test_completing_a_file_that_is_not_a_video_leaves_the_row_open(
    client, db, assigned_video, participant_headers, bucket, landed
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    landed["error"] = UploadRejected("That file is not a video we can play.")

    r = await _complete(client, recording_id, token)
    assert r.status_code == 400
    assert "not a video" in r.text

    row = await db.get(ScreenRecording, recording_id)
    await db.refresh(row)
    assert row.status != "stored"


async def test_completing_still_needs_the_epoch(
    client, assigned_video, participant_headers, bucket, landed
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    r = await _complete(client, recording_id, token, epoch_ms=0)
    assert r.status_code == 400
    assert landed["checked"] == []


async def test_a_token_cannot_complete_someone_elses_recording(
    client, assigned_video, participant_headers, bucket, landed
):
    first, first_token = await _open(client, participant_headers, assigned_video.id)
    second, _ = await _open(client, participant_headers, assigned_video.id)
    assert first != second

    assert (await _complete(client, second, first_token)).status_code == 403
    assert (await _ask(client, second, first_token)).status_code == 403
    assert landed["checked"] == []


async def test_a_recording_cannot_be_completed_twice(
    client, assigned_video, participant_headers, bucket, landed
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    assert (await _complete(client, recording_id, token)).status_code == 200
    assert (await _complete(client, recording_id, token)).status_code == 409
    assert (await _ask(client, recording_id, token)).status_code == 409


async def test_completing_makes_no_sense_without_a_bucket(
    client, assigned_video, participant_headers, landed
):
    recording_id, token = await _open(client, participant_headers, assigned_video.id)
    r = await _complete(client, recording_id, token)
    assert r.status_code == 409
    assert landed["checked"] == []


# --- the case clip --------------------------------------------------------


async def test_a_clip_upload_is_given_a_name_the_app_minted(
    client, seed_study, admin_headers, bucket, sessions
):
    r = await client.post(
        f"/admin/studies/{seed_study.id}/videos/upload-url",
        headers=admin_headers,
        json={"filename": "case one.mp4", "size_bytes": 1_000_000, "content_type": "video/mp4"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "resumable"
    assert body["upload_url"] == SESSION_URL
    # Not the name the admin chose: theirs never reaches the bucket.
    assert body["object_name"].endswith(".mp4")
    assert "case one" not in body["object_name"]
    assert sessions[0][0] == body["object_name"]


async def test_a_clip_upload_refuses_a_file_type_we_cannot_play(
    client, seed_study, admin_headers, bucket, sessions
):
    r = await client.post(
        f"/admin/studies/{seed_study.id}/videos/upload-url",
        headers=admin_headers,
        json={"filename": "notes.pdf", "size_bytes": 1000, "content_type": "application/pdf"},
    )
    assert r.status_code == 415
    assert sessions == []


async def test_finalising_a_clip_records_it_against_the_study(
    client, db, seed_study, admin_headers, bucket, sessions, landed
):
    opened = await client.post(
        f"/admin/studies/{seed_study.id}/videos/upload-url",
        headers=admin_headers,
        json={"filename": "case.mp4", "size_bytes": 1_000_000},
    )
    name = opened.json()["object_name"]

    r = await client.post(
        f"/admin/studies/{seed_study.id}/videos/finalize",
        headers=admin_headers,
        json={"object_name": name, "title": "Case one", "phase_type": "training"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["title"] == "Case one"

    video = await db.get(Video, r.json()["id"])
    await db.refresh(video)
    assert video.gcp_filename == name
    assert landed["checked"][0][0] == name


async def test_finalising_cannot_be_pointed_at_an_object_we_did_not_mint(
    client, seed_study, admin_headers, bucket, landed
):
    for name in (
        "screens/T-001/1.mp4",  # a participant's capture
        "../../etc/passwd",
        "someone-elses-clip.mp4",
        "deadbeef.mp4",  # right shape, wrong length
    ):
        r = await client.post(
            f"/admin/studies/{seed_study.id}/videos/finalize",
            headers=admin_headers,
            json={"object_name": name, "title": "Nope"},
        )
        assert r.status_code == 400, f"{name} was accepted"
    # None of them got as far as touching the bucket.
    assert landed["checked"] == []


async def test_finalising_a_file_that_is_not_a_video_creates_nothing(
    client, db, seed_study, admin_headers, bucket, sessions, landed
):
    opened = await client.post(
        f"/admin/studies/{seed_study.id}/videos/upload-url",
        headers=admin_headers,
        json={"filename": "case.mp4", "size_bytes": 1000},
    )
    landed["error"] = UploadRejected("That file is not a video we can play.")

    r = await client.post(
        f"/admin/studies/{seed_study.id}/videos/finalize",
        headers=admin_headers,
        json={"object_name": opened.json()["object_name"], "title": "Nope"},
    )
    assert r.status_code == 415

    rows = await client.get(f"/admin/studies/{seed_study.id}/videos", headers=admin_headers)
    assert rows.json() == []


# --- what the bucket check itself does ------------------------------------


class _Blob:
    def __init__(self, size, head, missing=False):
        self.size = size
        self._head = head
        self._missing = missing
        self.deleted = False

    def reload(self):
        if self._missing:
            from google.api_core.exceptions import NotFound

            raise NotFound("no such object")

    def download_as_bytes(self, start=0, end=None):
        return self._head

    def delete(self):
        self.deleted = True


def _with_blob(monkeypatch, blob):
    monkeypatch.setattr(
        storage, "_bucket", lambda settings: type("B", (), {"blob": lambda _s, _n: blob})()
    )
    return blob


def test_a_good_object_is_accepted_at_its_stored_size(monkeypatch):
    blob = _with_blob(monkeypatch, _Blob(4096, _mp4(64)))
    assert storage.verify_uploaded_blob("x.mp4", 10_000, object()) == 4096
    assert blob.deleted is False


def test_an_object_that_is_not_a_video_is_removed_not_just_refused(monkeypatch):
    blob = _with_blob(monkeypatch, _Blob(4096, b"<html>" + b"\0" * 58))
    with pytest.raises(UploadRejected):
        storage.verify_uploaded_blob("x.mp4", 10_000, object())
    # Leaving it there would mean an upload token could park a file in the bucket.
    assert blob.deleted is True


def test_an_oversized_object_is_removed(monkeypatch):
    blob = _with_blob(monkeypatch, _Blob(20_000, _mp4(64)))
    with pytest.raises(UploadRejected):
        storage.verify_uploaded_blob("x.mp4", 10_000, object())
    assert blob.deleted is True


def test_an_empty_object_is_removed(monkeypatch):
    blob = _with_blob(monkeypatch, _Blob(0, b""))
    with pytest.raises(UploadRejected):
        storage.verify_uploaded_blob("x.mp4", 10_000, object())
    assert blob.deleted is True


def test_an_upload_that_never_finished_is_reported_not_stored(monkeypatch):
    blob = _with_blob(monkeypatch, _Blob(0, b"", missing=True))
    with pytest.raises(UploadRejected, match="No file was uploaded"):
        storage.verify_uploaded_blob("x.mp4", 10_000, object())
    assert blob.deleted is False
