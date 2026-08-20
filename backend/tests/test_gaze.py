import pytest
import pytest_asyncio

from app.core.security import create_access_token
from app.models.enums import ParticipantStatus, PhaseType
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.session import Session
from app.models.video import Video
from app.services import storage

SAMPLE = {"ts": 1000, "lx": 0.5, "ly": 0.5, "rx": 0.5, "ry": 0.5, "lv": True, "rv": True}

GEOMETRY = {
    "ts": 1000,
    "screen": {"w": 2560, "h": 1440},
    "window": {
        "x": 0,
        "y": 0,
        "outer_w": 2560,
        "outer_h": 1440,
        "inner_w": 2560,
        "inner_h": 1340,
    },
    "video": {"x": 40, "y": 120, "w": 1400, "h": 788},
    "frame": {"w": 1920, "h": 1080},
    "dpr": 2,
}


@pytest.fixture(autouse=True)
def uploads(tmp_path, monkeypatch):
    """Chunks go to a throwaway tree, not the real uploads folder."""
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


async def _start(client, headers, video_id, geometry=None):
    body = {"video_id": video_id, "sampling_rate_hz": 120}
    if geometry is not None:
        body["geometry"] = geometry
    return await client.post("/gaze/recordings", json=body, headers=headers)


async def test_start_recording(client, assigned_video, participant_headers):
    r = await _start(client, participant_headers, assigned_video.id)
    assert r.status_code == 201
    assert isinstance(r.json()["recording_id"], int)


async def test_start_recording_unassigned_video_404(client, seed_participant, participant_headers):
    r = await _start(client, participant_headers, 999999)
    assert r.status_code == 404


async def test_upload_then_complete_then_reject(client, assigned_video, participant_headers):
    rec = (await _start(client, participant_headers, assigned_video.id)).json()["recording_id"]

    up = await client.post(
        f"/gaze/recordings/{rec}/samples", json={"samples": [SAMPLE]}, headers=participant_headers
    )
    assert up.status_code == 200
    assert up.json()["total_sample_count"] == 1

    done = await client.patch(
        f"/gaze/recordings/{rec}/complete", json={"sample_count": 1}, headers=participant_headers
    )
    assert done.status_code == 200

    # No more samples once finalised.
    again = await client.post(
        f"/gaze/recordings/{rec}/samples", json={"samples": [SAMPLE]}, headers=participant_headers
    )
    assert again.status_code == 409


async def test_each_batch_claims_its_own_chunk(
    client, db, uploads, assigned_video, participant_headers
):
    rec_id = (await _start(client, participant_headers, assigned_video.id)).json()["recording_id"]

    for batch in ([SAMPLE] * 3, [SAMPLE] * 2, [SAMPLE] * 4):
        r = await client.post(
            f"/gaze/recordings/{rec_id}/samples",
            json={"samples": batch},
            headers=participant_headers,
        )
        assert r.status_code == 200

    recording = await db.get(GazeRecording, rec_id)
    assert recording.sample_count == 9

    # One file per batch, named from the offset it claimed — no batch landed on
    # another's name and overwrote it.
    chunks = sorted(p.name for p in (uploads / "gaze" / "T-001" / str(rec_id)).iterdir())
    assert chunks == [
        "chunk_000000000.ndjson",
        "chunk_000000003.ndjson",
        "chunk_000000005.ndjson",
    ]
    written = sum(
        len(p.read_text().strip().splitlines())
        for p in (uploads / "gaze" / "T-001" / str(rec_id)).iterdir()
    )
    assert written == 9


async def test_a_failed_write_does_not_leave_a_gap_in_the_count(
    client, db, monkeypatch, assigned_video, participant_headers
):
    rec_id = (await _start(client, participant_headers, assigned_video.id)).json()["recording_id"]
    await client.post(
        f"/gaze/recordings/{rec_id}/samples",
        json={"samples": [SAMPLE]},
        headers=participant_headers,
    )

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("pathlib.Path.write_text", boom)
    with pytest.raises(OSError):
        await client.post(
            f"/gaze/recordings/{rec_id}/samples",
            json={"samples": [SAMPLE] * 5},
            headers=participant_headers,
        )

    monkeypatch.undo()
    await db.rollback()
    recording = await db.get(GazeRecording, rec_id)
    await db.refresh(recording)
    assert recording.sample_count == 1  # the failed claim rolled back


async def test_calibration_is_stored_with_its_accuracy(
    client, db, seed_participant, participant_headers
):
    r = await client.post(
        "/gaze/calibration",
        json={
            "status": "success",
            "mean_offset": 0.012,
            "mean_offset_degrees": 0.61,
            "points": [
                {
                    "target_x": 0.25,
                    "target_y": 0.25,
                    "gaze_x": 0.26,
                    "gaze_y": 0.24,
                    "offset": 0.012,
                    "samples": 118,
                }
            ],
        },
        headers=participant_headers,
    )
    assert r.status_code == 201
    assert r.json()["mean_offset_degrees"] == 0.61

    stored = await db.get(GazeCalibration, r.json()["id"])
    assert stored.participant_id == seed_participant.id
    assert stored.status == "success"
    assert stored.points[0]["samples"] == 118


async def test_a_skipped_calibration_is_recorded_too(client, participant_headers):
    # Running without a tracker is a fact about the data, not an absence of one.
    r = await client.post(
        "/gaze/calibration", json={"status": "skipped"}, headers=participant_headers
    )
    assert r.status_code == 201
    assert r.json()["status"] == "skipped"
    assert r.json()["mean_offset"] is None


async def test_calibration_status_is_constrained(client, participant_headers):
    r = await client.post(
        "/gaze/calibration", json={"status": "probably-fine"}, headers=participant_headers
    )
    assert r.status_code == 422


async def test_latest_calibration_is_the_newest_attempt(client, participant_headers):
    assert (await client.get("/gaze/calibration", headers=participant_headers)).json() is None

    await client.post("/gaze/calibration", json={"status": "failed"}, headers=participant_headers)
    await client.post(
        "/gaze/calibration",
        json={"status": "success", "mean_offset": 0.01},
        headers=participant_headers,
    )

    latest = (await client.get("/gaze/calibration", headers=participant_headers)).json()
    assert latest["status"] == "success"


async def test_replay_shape_without_recording(client, assigned_video, participant_headers):
    r = await client.get(f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["video_url"] == "/uploads/videos/v.mp4"
    assert data["points"] == []
    assert data["plotted_points"] == 0
    assert data["has_geometry"] is False


async def test_start_recording_stores_the_screen_geometry(
    client, db, assigned_video, participant_headers
):
    rec_id = (await _start(client, participant_headers, assigned_video.id, GEOMETRY)).json()[
        "recording_id"
    ]

    recording = await db.get(GazeRecording, rec_id)
    assert len(recording.geometry) == 1
    assert recording.geometry[0]["video"] == GEOMETRY["video"]
    assert recording.geometry[0]["frame"] == GEOMETRY["frame"]


async def test_geometry_snapshots_accumulate_in_time_order(
    client, db, assigned_video, participant_headers
):
    rec_id = (await _start(client, participant_headers, assigned_video.id, GEOMETRY)).json()[
        "recording_id"
    ]
    resized = {**GEOMETRY, "ts": 5000, "video": {"x": 0, "y": 0, "w": 800, "h": 450}}

    r = await client.post(
        f"/gaze/recordings/{rec_id}/geometry", json=resized, headers=participant_headers
    )
    assert r.status_code == 202
    assert r.json()["snapshots"] == 2

    recording = await db.get(GazeRecording, rec_id)
    await db.refresh(recording)
    assert [g["ts"] for g in recording.geometry] == [1000, 5000]


async def test_geometry_is_refused_after_the_recording_is_finalised(
    client, assigned_video, participant_headers
):
    rec_id = (await _start(client, participant_headers, assigned_video.id, GEOMETRY)).json()[
        "recording_id"
    ]
    await client.patch(
        f"/gaze/recordings/{rec_id}/complete", json={"sample_count": 0}, headers=participant_headers
    )

    r = await client.post(
        f"/gaze/recordings/{rec_id}/geometry", json=GEOMETRY, headers=participant_headers
    )
    assert r.status_code == 409


async def test_geometry_belongs_to_its_own_participant(
    client, db, assigned_video, participant_headers, seed_study
):
    other = Participant(id="T-002", study_id=seed_study.id)
    db.add(other)
    await db.flush()
    stolen = create_access_token({"sub": other.id, "role": "participant"})

    rec_id = (await _start(client, participant_headers, assigned_video.id, GEOMETRY)).json()[
        "recording_id"
    ]
    r = await client.post(
        f"/gaze/recordings/{rec_id}/geometry",
        json=GEOMETRY,
        headers={"Authorization": f"Bearer {stolen}"},
    )
    assert r.status_code == 404


async def test_replay_maps_samples_onto_the_picture(
    client, db, assigned_video, seed_participant, participant_headers
):
    # The clip sits at x=40..1440 on a 2560-wide screen, so gaze at the middle
    # of the screen lands near the clip's right-hand edge, not at its centre —
    # which is where plotting the raw coordinate would have put it.
    rec_id = (await _start(client, participant_headers, assigned_video.id, GEOMETRY)).json()[
        "recording_id"
    ]
    await client.post(
        f"/gaze/recordings/{rec_id}/samples",
        json={"samples": [{**SAMPLE, "ts": 2000}]},
        headers=participant_headers,
    )
    db.add(
        InteractionLog(
            participant_id=seed_participant.id,
            video_id=assigned_video.id,
            event_type="video_started",
            payload={"currentTime": 0},
            client_ts=1000,
        )
    )
    await db.flush()

    data = (
        await client.get(f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers)
    ).json()
    assert data["has_geometry"] is True
    assert data["plotted_points"] == 1
    assert data["points"][0] == {
        "t": 1000,
        "x": pytest.approx(0.8857, abs=1e-3),
        "y": pytest.approx(0.6346, abs=1e-3),
    }


async def test_replay_without_geometry_says_so(
    client, db, assigned_video, seed_participant, participant_headers
):
    rec_id = (await _start(client, participant_headers, assigned_video.id)).json()["recording_id"]
    await client.post(
        f"/gaze/recordings/{rec_id}/samples",
        json={"samples": [{**SAMPLE, "ts": 2000}]},
        headers=participant_headers,
    )
    db.add(
        InteractionLog(
            participant_id=seed_participant.id,
            video_id=assigned_video.id,
            event_type="video_started",
            payload={"currentTime": 0},
            client_ts=1000,
        )
    )
    await db.flush()

    data = (
        await client.get(f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers)
    ).json()
    assert data["has_geometry"] is False
    assert data["points"][0]["x"] == 0.5  # passed through, unplaceable on the picture
