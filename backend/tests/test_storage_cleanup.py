"""Deleting a row has to delete the file behind it — most of all for gaze."""

import pytest
import pytest_asyncio

from app.models.enums import PhaseType
from app.models.gaze_recording import GazeRecording
from app.models.participant import Participant
from app.models.video import Video
from app.services import storage


@pytest.fixture(autouse=True)
def uploads(tmp_path, monkeypatch):
    """Point the storage helpers at a throwaway tree, not the real uploads."""
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    (tmp_path / "videos").mkdir()
    (tmp_path / "gaze").mkdir()
    return tmp_path


def _video_file(uploads, name="clip.mp4"):
    path = uploads / "videos" / name
    path.write_bytes(b"not really an mp4")
    return path


def _gaze_chunks(uploads, participant_id, recording_id):
    folder = uploads / "gaze" / participant_id / str(recording_id)
    folder.mkdir(parents=True)
    (folder / "chunk_000000000.ndjson").write_text('{"ts": 1}\n')
    return folder


@pytest_asyncio.fixture
async def video(db, seed_study):
    v = Video(
        study_id=seed_study.id, title="V", phase_type=PhaseType.pre_test, gcp_filename="clip.mp4"
    )
    db.add(v)
    await db.flush()
    return v


async def test_deleting_a_video_removes_its_file(client, uploads, video, admin_headers):
    path = _video_file(uploads)

    r = await client.delete(f"/admin/videos/{video.id}", headers=admin_headers)

    assert r.status_code == 200
    assert not path.exists()


async def test_deleting_a_video_removes_its_gaze_chunks(
    client, db, uploads, video, seed_participant, admin_headers
):
    _video_file(uploads)
    recording = GazeRecording(participant_id=seed_participant.id, video_id=video.id)
    db.add(recording)
    await db.flush()
    chunks = _gaze_chunks(uploads, seed_participant.id, recording.id)

    await client.delete(f"/admin/videos/{video.id}", headers=admin_headers)

    assert not chunks.exists()


async def test_deleting_a_participant_erases_their_gaze(
    client, uploads, seed_participant, admin_headers
):
    folder = _gaze_chunks(uploads, seed_participant.id, 1)

    r = await client.delete(f"/admin/participants/{seed_participant.id}", headers=admin_headers)

    assert r.status_code == 200
    assert not folder.exists()
    assert not folder.parent.exists()


async def test_deleting_a_participant_leaves_other_participants_alone(
    client, db, uploads, seed_study, seed_participant, admin_headers
):
    other = Participant(id="T-002", study_id=seed_study.id)
    db.add(other)
    await db.flush()
    mine = _gaze_chunks(uploads, seed_participant.id, 1)
    theirs = _gaze_chunks(uploads, other.id, 2)

    await client.delete(f"/admin/participants/{seed_participant.id}", headers=admin_headers)

    assert not mine.exists()
    assert theirs.exists()


async def test_force_deleting_a_study_takes_its_videos_and_gaze(
    client, uploads, seed_study, video, seed_participant, admin_headers
):
    path = _video_file(uploads)
    folder = _gaze_chunks(uploads, seed_participant.id, 1)

    r = await client.delete(f"/admin/studies/{seed_study.id}?force=true", headers=admin_headers)

    assert r.status_code == 200
    assert not path.exists()
    assert not folder.exists()


async def test_a_missing_file_is_not_an_error(client, video, admin_headers):
    # The row is the source of truth; a file already gone must not 500.
    r = await client.delete(f"/admin/videos/{video.id}", headers=admin_headers)
    assert r.status_code == 200


async def test_ids_cannot_escape_the_uploads_tree(client, uploads, seed_study, admin_headers):
    r = await client.post(
        f"/admin/studies/{seed_study.id}/participants",
        json={"ids": ["../../etc/passwd", "T-003/nested", "ok-1"]},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert sorted(r.json()["detail"]["ids"]) == ["../../etc/passwd", "T-003/nested"]


def test_delete_helpers_refuse_paths_outside_uploads(uploads, monkeypatch):
    outside = uploads.parent / "keep-me"
    outside.mkdir()
    (outside / "important").write_text("x")

    settings = type("S", (), {"GCP_BUCKET_NAME": "", "GAZE_STORAGE_MODE": "local"})()
    storage.delete_participant_gaze("../keep-me", settings)

    assert (outside / "important").exists()
