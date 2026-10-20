import json
from types import SimpleNamespace

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


@pytest.fixture
def fake_gcs(monkeypatch):
    """Exercise the real upload/retry branches without credentials or network."""
    from google.cloud import storage as gcs

    state = SimpleNamespace(objects={}, fail_download=False, fail_upload=False, closes=0)
    settings = SimpleNamespace(
        GAZE_STORAGE_MODE="gcs", GCP_BUCKET_NAME="gaze-test", GAZE_BATCH_UPLOAD_MAX_SAMPLES=5000
    )

    class Blob:
        def __init__(self, name):
            self.name = name

        def upload_from_string(self, data, content_type):
            assert content_type == "application/x-ndjson"
            if state.fail_upload:
                raise OSError("storage write unavailable")
            state.objects[self.name] = data.encode("utf-8")

        def exists(self):
            return self.name in state.objects

        def download_as_bytes(self):
            if state.fail_download:
                raise OSError("storage read unavailable")
            return state.objects[self.name]

    class Client:
        def bucket(self, name):
            assert name == "gaze-test"
            return SimpleNamespace(blob=Blob)

        def close(self):
            state.closes += 1

    monkeypatch.setattr(gcs, "Client", Client)
    monkeypatch.setattr("app.api.gaze.get_settings", lambda: settings)
    state.settings = settings
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


async def test_diagnosis_capture_infers_its_studys_rating_battery(
    client, db, assigned_video, seed_study, participant_headers
):
    from app.models.questionnaire import Questionnaire

    ratings = Questionnaire(study_id=seed_study.id, placement="diagnosis", title="Confidence")
    db.add(ratings)
    await db.flush()
    response = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={
            "step_kind": "diagnosis",
            "video_id": assigned_video.id,
            "sampling_rate_hz": 120,
        },
    )
    assert response.status_code == 201
    recording = await db.get(GazeRecording, response.json()["recording_id"])
    assert recording.questionnaire_id == ratings.id


async def test_retrying_a_committed_offset_does_not_append_samples(
    client, db, uploads, assigned_video, participant_headers
):
    recording_id = (await _start(client, participant_headers, assigned_video.id)).json()[
        "recording_id"
    ]
    url = f"/gaze/recordings/{recording_id}/samples"
    batch = {"offset": 0, "samples": [SAMPLE] * 3}
    first = await client.post(url, headers=participant_headers, json=batch)
    repeated = await client.post(url, headers=participant_headers, json=batch)
    assert first.json()["total_sample_count"] == repeated.json()["total_sample_count"] == 3
    assert repeated.json()["duplicate"] is True
    for bad in (
        {"offset": 0, "samples": [{**SAMPLE, "ts": 999}] * 3},
        {"offset": 9, "samples": [SAMPLE]},
        {"offset": 1, "samples": [SAMPLE]},
        {"offset": 0, "samples": [SAMPLE] * 4},
    ):
        assert (await client.post(url, headers=participant_headers, json=bad)).status_code == 409
    await client.patch(
        f"/gaze/recordings/{recording_id}/complete",
        headers=participant_headers,
        json={"sample_count": 3},
    )
    # A delayed acknowledgement retry is harmless even after finalisation.
    assert (await client.post(url, headers=participant_headers, json=batch)).json()[
        "duplicate"
    ] is True
    recording = await db.get(GazeRecording, recording_id)
    assert recording.sample_count == 3
    folder = uploads / "gaze" / "T-001" / str(recording_id)
    chunks = list(folder.glob("*.ndjson"))
    assert len(chunks) == 1 and len(chunks[0].read_text().splitlines()) == 3


async def test_gcs_offset_retry_reads_original_bytes_and_keeps_one_chunk(
    client, db, fake_gcs, assigned_video, participant_headers
):
    recording_id = (await _start(client, participant_headers, assigned_video.id)).json()[
        "recording_id"
    ]
    url = f"/gaze/recordings/{recording_id}/samples"
    batch = {"offset": 0, "samples": [SAMPLE, {**SAMPLE, "ts": 1001, "geometry_ts": None}]}
    first = await client.post(url, headers=participant_headers, json=batch)
    assert first.status_code == 200 and first.json()["total_sample_count"] == 2
    original = dict(fake_gcs.objects)
    closes_before_retry = fake_gcs.closes
    # A later config change must not redirect a historical recording to local disk.
    fake_gcs.settings.GAZE_STORAGE_MODE = "local"
    retry = await client.post(url, headers=participant_headers, json=batch)
    assert retry.status_code == 200
    assert retry.json() == {"status": "ok", "total_sample_count": 2, "duplicate": True}
    assert fake_gcs.objects == original and len(original) == 1
    assert fake_gcs.closes == closes_before_retry + 1
    recording = await db.get(GazeRecording, recording_id)
    assert recording.sample_count == 2 and recording.storage_mode == "gcs"
    stored = [json.loads(line) for line in next(iter(original.values())).splitlines()]
    assert "geometry_ts" not in stored[0] and stored[1]["geometry_ts"] is None


@pytest.mark.parametrize(
    ("damage", "expected_status"),
    [("mismatch", 409), ("missing", 409), ("prefix", 409), ("download", 503), ("bucket", 503)],
)
async def test_gcs_retry_never_accepts_unverifiable_or_different_data(
    client, db, fake_gcs, assigned_video, participant_headers, damage, expected_status
):
    recording_id = (await _start(client, participant_headers, assigned_video.id)).json()[
        "recording_id"
    ]
    url = f"/gaze/recordings/{recording_id}/samples"
    batch = {"offset": 0, "samples": [SAMPLE]}
    assert (await client.post(url, headers=participant_headers, json=batch)).status_code == 200
    key = next(iter(fake_gcs.objects))
    if damage == "mismatch":
        fake_gcs.objects[key] = b"different bytes\n"
    elif damage == "missing":
        fake_gcs.objects.clear()
    elif damage == "prefix":
        recording = await db.get(GazeRecording, recording_id)
        recording.storage_prefix = None
        await db.commit()
    elif damage == "download":
        fake_gcs.fail_download = True
    else:
        fake_gcs.settings.GCP_BUCKET_NAME = ""
    objects_before_retry = dict(fake_gcs.objects)
    closes_before_retry = fake_gcs.closes
    retry = await client.post(url, headers=participant_headers, json=batch)
    assert retry.status_code == expected_status
    assert (await db.get(GazeRecording, recording_id)).sample_count == 1
    assert fake_gcs.objects == objects_before_retry
    if damage not in {"prefix", "bucket"}:
        assert fake_gcs.closes == closes_before_retry + 1


@pytest.mark.parametrize("failure", ["upload", "bucket"])
async def test_gcs_failed_upload_rolls_back_offset_and_can_be_retried(
    client, db, fake_gcs, assigned_video, participant_headers, failure
):
    recording_id = (await _start(client, participant_headers, assigned_video.id)).json()[
        "recording_id"
    ]
    url = f"/gaze/recordings/{recording_id}/samples"
    batch = {"offset": 0, "samples": [SAMPLE]}
    fake_gcs.fail_upload = failure == "upload"
    if failure == "bucket":
        fake_gcs.settings.GCP_BUCKET_NAME = ""
    failed = await client.post(url, headers=participant_headers, json=batch)
    assert failed.status_code == 503
    # The shared test session needs the rollback that production get_db provides
    # when a request exits with an exception.
    await db.rollback()
    recording = await db.get(GazeRecording, recording_id)
    assert recording.sample_count == 0 and recording.storage_prefix is None
    assert fake_gcs.objects == {}
    fake_gcs.fail_upload = False
    fake_gcs.settings.GCP_BUCKET_NAME = "gaze-test"
    retried = await client.post(url, headers=participant_headers, json=batch)
    assert retried.status_code == 200 and retried.json()["total_sample_count"] == 1
    assert len(fake_gcs.objects) == 1
    assert next(iter(fake_gcs.objects)).endswith("/chunk_000000000.ndjson")


@pytest.mark.parametrize("step_kind", ["case_video", "diagnosis", "case_outro", "questionnaire"])
async def test_capture_context_requires_its_video_or_questionnaire(
    client, participant_headers, step_kind
):
    response = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={"step_kind": step_kind, "sampling_rate_hz": 120},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("wrong_study", [False, True])
async def test_capture_context_rejects_wrong_questionnaire_placement_or_study(
    client, db, seed_study, assigned_video, participant_headers, wrong_study
):
    from app.models.questionnaire import Questionnaire
    from app.models.study import Study

    study = seed_study
    if wrong_study:
        study = Study(name="Other study")
        db.add(study)
        await db.flush()
    question = Questionnaire(
        study_id=study.id,
        placement="diagnosis" if wrong_study else "case_outro",
        title="Wrong battery",
    )
    db.add(question)
    await db.flush()
    response = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={
            "step_kind": "diagnosis",
            "video_id": assigned_video.id,
            "questionnaire_id": question.id,
            "sampling_rate_hz": 120,
        },
    )
    assert response.status_code == 404


@pytest.mark.parametrize("same_payload", [True, False])
async def test_concurrent_offset_uploads_append_once(uploads, same_payload):
    import asyncio
    from uuid import uuid4

    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import delete
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import get_db
    from app.models.study import Study
    from main import app
    from tests.conftest import TEST_DATABASE_URL

    # Separate committed sessions are required to exercise the row lock;
    # the ordinary client fixture intentionally shares one rolled-back connection.
    engine = create_async_engine(TEST_DATABASE_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    participant_id = f"CONCURRENT-{uuid4().hex}"
    async with factory() as session:
        study = Study(name="Concurrent upload test")
        session.add(study)
        await session.flush()
        participant = Participant(id=participant_id, study_id=study.id)
        video = Video(study_id=study.id, title="Concurrent case")
        session.add_all([participant, video])
        await session.flush()
        recording = GazeRecording(participant_id=participant.id, video_id=video.id)
        session.add(recording)
        await session.commit()

    async def isolated_db():
        async with factory() as session:
            yield session

    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = isolated_db
    try:
        token = create_access_token({"sub": participant_id, "role": "participant"})
        headers = {"Authorization": f"Bearer {token}"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            responses = await asyncio.gather(
                *[
                    client.post(
                        f"/gaze/recordings/{recording.id}/samples",
                        headers=headers,
                        json={"offset": 0, "samples": [point]},
                    )
                    for point in (SAMPLE, SAMPLE if same_payload else {**SAMPLE, "ts": 2000})
                ]
            )
        assert sorted(r.status_code for r in responses) == (
            [200, 200] if same_payload else [200, 409]
        )
        async with factory() as session:
            persisted = await session.get(GazeRecording, recording.id)
            assert persisted.sample_count == 1
        chunks = list((uploads / "gaze" / participant_id / str(recording.id)).glob("*.ndjson"))
        assert len(chunks) == 1 and len(chunks[0].read_text().splitlines()) == 1
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        async with factory() as session:
            await session.execute(delete(Study).where(Study.id == study.id))
            await session.commit()
        await engine.dispose()


async def test_questionnaire_gaze_does_not_replace_case_replay(
    client, db, assigned_video, seed_participant, participant_headers, monkeypatch
):
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    case = GazeRecording(
        participant_id=seed_participant.id,
        video_id=assigned_video.id,
        step_kind="case_video",
        started_at=now,
    )
    later = GazeRecording(
        participant_id=seed_participant.id,
        video_id=assigned_video.id,
        step_kind="diagnosis",
        started_at=now + timedelta(minutes=5),
    )
    db.add_all([case, later])
    await db.flush()
    selected = []

    async def replay(_db, recording, _settings):
        selected.append(recording.id)
        return {
            "mapped_samples": 0,
            "invalid_samples": 0,
            "unmapped_samples": 0,
            "offscreen_samples": 0,
            "has_geometry": False,
            "points": [],
        }

    monkeypatch.setattr("app.api.gaze.compute_replay", replay)
    response = await client.get(
        f"/gaze/videos/{assigned_video.id}/replay", headers=participant_headers
    )
    assert response.status_code == 200
    assert selected == [case.id]


async def test_geometry_limit_preserves_history_and_marks_future_aoi_unavailable(
    client, db, assigned_video, participant_headers, monkeypatch
):
    monkeypatch.setattr("app.api.gaze.MAX_GEOMETRY_SNAPSHOTS", 1)
    rec = (await _start(client, participant_headers, assigned_video.id, GEOMETRY)).json()[
        "recording_id"
    ]
    rejected = await client.post(
        f"/gaze/recordings/{rec}/geometry",
        headers=participant_headers,
        json={**GEOMETRY, "ts": 2000, "aois": []},
    )
    assert rejected.status_code == 409
    recording = await db.get(GazeRecording, rec)
    assert recording.geometry[0]["ts"] == 1000
    assert recording.geometry[1]["ts"] == 2000
    assert recording.geometry[1]["visible"] is False and recording.geometry[1]["aois"] is None


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


async def test_geometry_persists_optional_visual_viewport_and_display_signals(
    client, db, assigned_video, participant_headers
):
    initial = {
        **GEOMETRY,
        "screen": {**GEOMETRY["screen"], "is_extended": True},
        "visual_viewport": {"scale": 2, "x": 25, "y": 10, "w": 1280, "h": 670},
    }
    response = await _start(client, participant_headers, assigned_video.id, initial)
    assert response.status_code == 201
    recording_id = response.json()["recording_id"]
    next_geometry = {
        **initial,
        "ts": 2000,
        "screen": {**GEOMETRY["screen"], "is_extended": False},
        "visual_viewport": {"scale": 1, "x": 0, "y": 0, "w": 2560, "h": 1340},
    }
    changed = await client.post(
        f"/gaze/recordings/{recording_id}/geometry",
        headers=participant_headers,
        json=next_geometry,
    )
    assert changed.status_code == 202
    recording = await db.get(GazeRecording, recording_id)
    await db.refresh(recording)
    assert recording.geometry[0]["visual_viewport"] == initial["visual_viewport"]
    assert recording.geometry[0]["screen"]["is_extended"] is True
    assert recording.geometry[1]["visual_viewport"] == next_geometry["visual_viewport"]
    assert recording.geometry[1]["screen"]["is_extended"] is False


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
