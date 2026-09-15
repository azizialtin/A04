"""The screen capture behind the think-aloud: opening one, taking the file from
the bridge, and getting gaze back on the right timeline."""

from __future__ import annotations

import struct

import pytest
import pytest_asyncio

from app.core.security import create_access_token
from app.models.enums import ParticipantStatus, PhaseType
from app.models.participant_video import ParticipantVideo
from app.models.screen_recording import ScreenRecording
from app.models.session import Session
from app.models.video import Video
from app.services import storage
from app.services.gaze_replay import build_screen_points

EPOCH = 1_700_000_000_000


def _mp4(size: int = 2048) -> bytes:
    """Enough of an ISO container header to get past the upload's own check."""
    return struct.pack(">I", 24) + b"ftypisom" + b"\0" * (size - 12)


@pytest.fixture(autouse=True)
def uploads(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    return tmp_path


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
    return await client.post("/screen/recordings", json={"video_id": video_id}, headers=headers)


async def _upload(client, recording_id, token, *, epoch_ms=EPOCH, duration_ms=60_000, body=None):
    return await client.post(
        f"/screen/recordings/{recording_id}/upload",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("screen.mp4", body if body is not None else _mp4(), "video/mp4")},
        data={
            "epoch_ms": str(epoch_ms),
            "duration_ms": str(duration_ms),
            "width": "1920",
            "height": "1080",
            "fps": "30",
        },
    )


# --- the timeline ---------------------------------------------------------


def test_screen_points_are_the_sample_clock_minus_the_start():
    samples = [
        {"ts": EPOCH + 500, "lx": 0.4, "ly": 0.6, "rx": 0.4, "ry": 0.6},
        {"ts": EPOCH + 1500, "lx": 0.2, "ly": 0.2, "rx": 0.4, "ry": 0.4},
    ]
    points, invalid, unmapped, offscreen = build_screen_points(samples, EPOCH, 60_000)
    assert [p["t"] for p in points] == [500, 1500]
    # Screen coordinates go through untouched — the recording is the display.
    assert points[0]["x"] == 0.4
    # ...averaged over both eyes, like everywhere else.
    assert points[1]["x"] == 0.3
    assert (invalid, unmapped, offscreen) == (0, 0, 0)


def test_screen_points_count_a_paused_stretch():
    """The clip-based mapping drops samples taken while paused; here they are
    real, because the screen was still being recorded."""
    samples = [{"ts": EPOCH + t, "lx": 0.5, "ly": 0.5, "rx": 0.5, "ry": 0.5} for t in (0, 30_000)]
    points, _, unmapped, _ = build_screen_points(samples, EPOCH, 60_000)
    assert len(points) == 2
    assert unmapped == 0


def test_screen_points_reject_samples_outside_the_recording():
    samples = [
        {"ts": EPOCH - 5_000, "lx": 0.5, "ly": 0.5, "rx": 0.5, "ry": 0.5},
        {"ts": EPOCH + 90_000, "lx": 0.5, "ly": 0.5, "rx": 0.5, "ry": 0.5},
    ]
    points, _, unmapped, _ = build_screen_points(samples, EPOCH, 60_000)
    assert points == []
    assert unmapped == 2


def test_screen_points_separate_a_blink_from_looking_away():
    samples = [
        {"ts": EPOCH + 10, "lx": None, "ly": None, "rx": None, "ry": None},
        {"ts": EPOCH + 20, "lx": 1.4, "ly": 0.5, "rx": 1.4, "ry": 0.5},
    ]
    points, invalid, _, offscreen = build_screen_points(samples, EPOCH, 60_000)
    assert points == []
    assert (invalid, offscreen) == (1, 1)


# --- opening and delivering -----------------------------------------------


async def test_open_then_upload_stores_the_file(
    client, assigned_video, participant_headers, uploads
):
    opened = await _open(client, participant_headers, assigned_video.id)
    assert opened.status_code == 201
    recording_id = opened.json()["recording_id"]

    r = await _upload(client, recording_id, opened.json()["upload_token"])
    assert r.status_code == 200, r.text
    assert r.json()["bytes"] == 2048
    assert (uploads / "screens" / "T-001" / f"{recording_id}.mp4").is_file()


async def test_upload_needs_the_epoch(client, assigned_video, participant_headers):
    opened = await _open(client, participant_headers, assigned_video.id)
    r = await _upload(
        client, opened.json()["recording_id"], opened.json()["upload_token"], epoch_ms=0
    )
    assert r.status_code == 400


async def test_upload_rejects_something_that_is_not_a_video(
    client, assigned_video, participant_headers
):
    opened = await _open(client, participant_headers, assigned_video.id)
    r = await _upload(
        client,
        opened.json()["recording_id"],
        opened.json()["upload_token"],
        body=b"<html>not a recording</html>",
    )
    assert r.status_code == 400


async def test_upload_will_not_take_the_same_recording_twice(
    client, assigned_video, participant_headers
):
    opened = await _open(client, participant_headers, assigned_video.id)
    rid, token = opened.json()["recording_id"], opened.json()["upload_token"]
    assert (await _upload(client, rid, token)).status_code == 200
    assert (await _upload(client, rid, token)).status_code == 409


async def test_the_upload_token_only_opens_its_own_recording(
    client, assigned_video, participant_headers
):
    first = await _open(client, participant_headers, assigned_video.id)
    second = await _open(client, participant_headers, assigned_video.id)
    r = await _upload(client, second.json()["recording_id"], first.json()["upload_token"])
    assert r.status_code == 403


async def test_a_participant_token_cannot_upload(
    client, assigned_video, participant_headers, participant_token
):
    opened = await _open(client, participant_headers, assigned_video.id)
    r = await _upload(client, opened.json()["recording_id"], participant_token)
    assert r.status_code == 401


async def test_another_participants_upload_token_is_refused(
    client, assigned_video, participant_headers, db, seed_study
):
    opened = await _open(client, participant_headers, assigned_video.id)
    recording_id = opened.json()["recording_id"]
    # Correct role, correct recording id, wrong person.
    forged = create_access_token(
        {"sub": "SOMEONE-ELSE", "role": "screen_upload", "rid": recording_id}
    )
    assert (await _upload(client, recording_id, forged)).status_code == 404


async def test_a_video_outside_the_run_cannot_be_recorded(
    client, assigned_video, participant_headers, db, seed_study
):
    """`assigned_video` gives the participant an explicit sequence, so a clip
    that is in the study but not in their run is off limits."""
    other = Video(study_id=seed_study.id, title="Other", phase_type=PhaseType.training)
    db.add(other)
    await db.flush()
    assert (await _open(client, participant_headers, other.id)).status_code == 404


async def test_a_failed_capture_says_so(client, assigned_video, participant_headers, db):
    opened = await _open(client, participant_headers, assigned_video.id)
    recording_id = opened.json()["recording_id"]
    r = await client.patch(
        f"/screen/recordings/{recording_id}/failed",
        json={"error": "ffmpeg is not on PATH"},
        headers=participant_headers,
    )
    assert r.status_code == 200
    row = await db.get(ScreenRecording, recording_id)
    await db.refresh(row)
    assert row.status == "failed"
    assert row.error == "ffmpeg is not on PATH"


async def test_the_bridge_can_report_its_own_failure(
    client, assigned_video, participant_headers, db
):
    """The failures that matter happen after the browser has moved on, so the
    upload token has to be enough to report one."""
    opened = await _open(client, participant_headers, assigned_video.id)
    recording_id = opened.json()["recording_id"]
    r = await client.patch(
        f"/screen/recordings/{recording_id}/failed",
        json={"error": "ffmpeg would not shut down"},
        headers={"Authorization": f"Bearer {opened.json()['upload_token']}"},
    )
    assert r.status_code == 200
    row = await db.get(ScreenRecording, recording_id)
    await db.refresh(row)
    assert row.status == "failed"


# --- what the think-aloud gets --------------------------------------------


async def _record_gaze(client, participant_headers, video_id, samples):
    started = await client.post(
        "/gaze/recordings",
        json={"video_id": video_id, "sampling_rate_hz": 120},
        headers=participant_headers,
    )
    rid = started.json()["recording_id"]
    await client.post(
        f"/gaze/recordings/{rid}/samples", json={"samples": samples}, headers=participant_headers
    )
    return rid


async def test_replay_prefers_the_screen_recording(client, assigned_video, participant_headers):
    await _record_gaze(
        client,
        participant_headers,
        assigned_video.id,
        [
            {
                "ts": EPOCH + 2_000,
                "lx": 0.3,
                "ly": 0.7,
                "rx": 0.3,
                "ry": 0.7,
                "lv": True,
                "rv": True,
            },
        ],
    )
    opened = await _open(client, participant_headers, assigned_video.id)
    await _upload(client, opened.json()["recording_id"], opened.json()["upload_token"])

    r = await client.get(f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "screen"
    assert data["epoch_ms"] == EPOCH
    assert data["video_url"].endswith(f"{opened.json()['recording_id']}.mp4")
    # Placed by the clock alone: no playback events were ever logged.
    assert data["points"] == [{"t": 2000, "x": 0.3, "y": 0.7}]


async def test_replay_falls_back_to_the_clip_when_the_capture_failed(
    client, assigned_video, participant_headers
):
    opened = await _open(client, participant_headers, assigned_video.id)
    await client.patch(
        f"/screen/recordings/{opened.json()['recording_id']}/failed",
        json={"error": "no ffmpeg"},
        headers=participant_headers,
    )
    r = await client.get(f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers)
    assert r.json()["source"] == "clip"
    assert r.json()["video_url"].endswith("v.mp4")


async def test_a_screen_recording_replays_without_any_gaze(
    client, assigned_video, participant_headers
):
    """A tracker that dropped out is exactly when you want to see what they did."""
    opened = await _open(client, participant_headers, assigned_video.id)
    await _upload(client, opened.json()["recording_id"], opened.json()["upload_token"])

    data = (
        await client.get(f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers)
    ).json()
    assert data["source"] == "screen"
    assert data["points"] == []
    assert data["sampling_rate_hz"] == 0


async def test_a_browser_capture_keeps_its_own_format(
    client, assigned_video, participant_headers, uploads, db
):
    """No bridge means the page records its own display as WebM. It is stored
    as what it is, and the row says who made it."""
    opened = await client.post(
        "/screen/recordings",
        json={"video_id": assigned_video.id, "recorder": "browser"},
        headers=participant_headers,
    )
    recording_id = opened.json()["recording_id"]
    webm = b"\x1a\x45\xdf\xa3" + b"\0" * 1020
    r = await client.post(
        f"/screen/recordings/{recording_id}/upload",
        headers={"Authorization": f"Bearer {opened.json()['upload_token']}"},
        files={"file": ("screen.webm", webm, "video/webm")},
        data={"epoch_ms": str(EPOCH), "duration_ms": "1000"},
    )
    assert r.status_code == 200, r.text
    assert (uploads / "screens" / "T-001" / f"{recording_id}.webm").is_file()
    assert not (uploads / "screens" / "T-001" / f"{recording_id}.mp4").exists()

    row = await db.get(ScreenRecording, recording_id)
    await db.refresh(row)
    assert row.recorder == "browser"

    replay = (
        await client.get(f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers)
    ).json()
    assert replay["source"] == "screen"
    assert replay["video_url"].endswith(f"{recording_id}.webm")


async def test_deleting_a_browser_capture_finds_the_webm(
    client, assigned_video, participant_headers, admin_headers, uploads
):
    opened = await client.post(
        "/screen/recordings",
        json={"video_id": assigned_video.id, "recorder": "browser"},
        headers=participant_headers,
    )
    recording_id = opened.json()["recording_id"]
    await client.post(
        f"/screen/recordings/{recording_id}/upload",
        headers={"Authorization": f"Bearer {opened.json()['upload_token']}"},
        files={"file": ("screen.webm", b"\x1a\x45\xdf\xa3" + b"\0" * 1020, "video/webm")},
        data={"epoch_ms": str(EPOCH)},
    )
    path = uploads / "screens" / "T-001" / f"{recording_id}.webm"
    assert path.is_file()

    assert (
        await client.delete(f"/admin/videos/{assigned_video.id}", headers=admin_headers)
    ).status_code == 409
    assert (
        await client.delete("/admin/participants/T-001", headers=admin_headers)
    ).status_code == 200
    assert not path.exists()


async def test_deleting_a_participant_deletes_their_screen_recordings(
    client, assigned_video, participant_headers, admin_headers, uploads
):
    opened = await _open(client, participant_headers, assigned_video.id)
    recording_id = opened.json()["recording_id"]
    await _upload(client, recording_id, opened.json()["upload_token"])
    path = uploads / "screens" / "T-001" / f"{recording_id}.mp4"
    assert path.is_file()

    r = await client.delete("/admin/participants/T-001", headers=admin_headers)
    assert r.status_code == 200
    assert not path.exists()
