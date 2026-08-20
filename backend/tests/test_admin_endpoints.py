"""The admin surface researchers use to set a study up.

This is the part where a mistake costs a session, and it was the least covered.
"""

import pytest
import pytest_asyncio

from app.models.enums import ParticipantStatus, PhaseType
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.video import Video
from app.services import storage

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 32


@pytest.fixture(autouse=True)
def uploads(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    return tmp_path


@pytest_asyncio.fixture
async def study(db, seed_study):
    return seed_study


@pytest_asyncio.fixture
async def videos(db, study):
    made = []
    for i, phase in enumerate([PhaseType.pre_test, PhaseType.training, PhaseType.post_test]):
        v = Video(study_id=study.id, title=f"Case {i}", phase_type=phase, gcp_filename=f"c{i}.mp4")
        db.add(v)
        made.append(v)
    await db.flush()
    return made


async def test_a_single_study_can_be_fetched(client, study, admin_headers):
    r = await client.get(f"/admin/studies/{study.id}", headers=admin_headers)

    assert r.status_code == 200
    assert r.json()["name"] == "Test Study"


async def test_fetching_a_study_that_is_not_there(client, admin_headers):
    assert (await client.get("/admin/studies/999999", headers=admin_headers)).status_code == 404


async def test_participants_are_listed_with_their_slot_counts(
    client, db, study, videos, seed_participant, admin_headers
):
    db.add_all(
        ParticipantVideo(
            participant_id=seed_participant.id,
            video_id=v.id,
            slot_index=i,
            phase_type=v.phase_type,
        )
        for i, v in enumerate(videos)
    )
    db.add(Participant(id="T-002", study_id=study.id))
    await db.flush()

    rows = (
        await client.get(f"/admin/studies/{study.id}/participants", headers=admin_headers)
    ).json()

    by_id = {r["id"]: r for r in rows}
    assert by_id["T-001"]["slot_count"] == 3
    assert by_id["T-002"]["slot_count"] == 0
    assert by_id["T-002"]["status"] == "registered"


async def test_questionnaires_are_listed_in_the_order_they_are_shown(client, study, admin_headers):
    for title, order in [("Second", 1), ("First", 0)]:
        await client.post(
            f"/admin/studies/{study.id}/questionnaires",
            json={"placement": "pre_test", "title": title, "order_index": order},
            headers=admin_headers,
        )

    rows = (
        await client.get(f"/admin/studies/{study.id}/questionnaires", headers=admin_headers)
    ).json()
    assert [q["title"] for q in rows] == ["First", "Second"]


async def test_a_questionnaire_can_be_edited(client, study, admin_headers):
    created = await client.post(
        f"/admin/studies/{study.id}/questionnaires",
        json={
            "placement": "pre_test",
            "title": "Before",
            "questions": [{"id": "a", "type": "likert", "text": "old"}],
        },
        headers=admin_headers,
    )
    qid = created.json()["id"]

    updated = await client.patch(
        f"/admin/questionnaires/{qid}",
        json={
            "title": "After",
            "placement": "case_outro",
            "questions": [{"id": "b", "type": "free_text", "text": "new"}],
        },
        headers=admin_headers,
    )

    assert updated.status_code == 200
    assert updated.json()["title"] == "After"
    assert updated.json()["placement"] == "case_outro"
    assert updated.json()["questions"][0]["id"] == "b"


async def test_editing_a_questionnaire_leaves_untouched_fields_alone(client, study, admin_headers):
    created = await client.post(
        f"/admin/studies/{study.id}/questionnaires",
        json={"placement": "pre_test", "title": "Keep", "description": "the description"},
        headers=admin_headers,
    )
    qid = created.json()["id"]

    updated = await client.patch(
        f"/admin/questionnaires/{qid}", json={"order_index": 7}, headers=admin_headers
    )

    assert updated.json()["description"] == "the description"
    assert updated.json()["placement"] == "pre_test"
    assert updated.json()["order_index"] == 7


async def test_editing_a_questionnaire_that_is_not_there(client, admin_headers):
    r = await client.patch(
        "/admin/questionnaires/999999", json={"title": "x"}, headers=admin_headers
    )
    assert r.status_code == 404


async def test_a_video_can_be_edited(client, videos, admin_headers):
    r = await client.patch(
        f"/admin/videos/{videos[0].id}",
        json={
            "title": "Renamed",
            "phase_type": "training",
            "task_description": "Find the bug",
            "time_limit_seconds": 300,
        },
        headers=admin_headers,
    )

    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Renamed"
    assert body["phase_type"] == "training"
    assert body["task_description"] == "Find the bug"
    assert body["time_limit_seconds"] == 300
    assert body["has_file"] is True  # editing text does not disturb the upload


async def test_editing_a_video_leaves_untouched_fields_alone(client, videos, admin_headers):
    r = await client.patch(
        f"/admin/videos/{videos[0].id}", json={"info_text": "some info"}, headers=admin_headers
    )

    assert r.json()["title"] == "Case 0"
    assert r.json()["phase_type"] == "pre_test"
    assert r.json()["info_text"] == "some info"


async def test_editing_a_video_rejects_a_phase_that_is_not_one(client, videos, admin_headers):
    r = await client.patch(
        f"/admin/videos/{videos[0].id}", json={"phase_type": "midterm"}, headers=admin_headers
    )
    assert r.status_code == 400


async def test_editing_a_video_that_is_not_there(client, admin_headers):
    r = await client.patch("/admin/videos/999999", json={"title": "x"}, headers=admin_headers)
    assert r.status_code == 404


async def test_bulk_assign_gives_every_participant_the_same_run(
    client, db, study, videos, admin_headers
):
    await client.post(
        f"/admin/studies/{study.id}/participants",
        json={"ids": ["B-1", "B-2", "B-3"]},
        headers=admin_headers,
    )
    items = [
        {"video_id": v.id, "slot_index": i, "phase_type": v.phase_type.value}
        for i, v in enumerate(videos)
    ]

    r = await client.post(
        f"/admin/studies/{study.id}/bulk-assign",
        json={"participant_ids": ["B-1", "B-2", "B-3"], "items": items},
        headers=admin_headers,
    )

    assert r.status_code == 200
    assert r.json() == {"applied": ["B-1", "B-2", "B-3"], "skipped": []}
    for pid in ("B-1", "B-2", "B-3"):
        detail = (await client.get(f"/admin/participants/{pid}", headers=admin_headers)).json()
        assert [s["video_id"] for s in detail["sequence"]] == [v.id for v in videos]


async def test_bulk_assign_skips_participants_who_have_started(
    client, db, study, videos, admin_headers
):
    await client.post(
        f"/admin/studies/{study.id}/participants",
        json={"ids": ["S-1", "S-2"]},
        headers=admin_headers,
    )
    started = await db.get(Participant, "S-1")
    started.status = ParticipantStatus.active
    await db.flush()

    r = await client.post(
        f"/admin/studies/{study.id}/bulk-assign",
        json={
            "participant_ids": ["S-1", "S-2", "NOBODY"],
            "items": [{"video_id": videos[0].id, "slot_index": 0, "phase_type": "pre_test"}],
        },
        headers=admin_headers,
    )

    assert r.json() == {"applied": ["S-2"], "skipped": ["S-1", "NOBODY"]}


async def test_bulk_assign_rejects_a_video_from_another_study(
    client, db, study, seed_researcher, admin_headers
):
    from app.models.study import Study

    other_study = Study(name="Someone else's", created_by=seed_researcher.id)
    db.add(other_study)
    await db.flush()
    foreign = Video(study_id=other_study.id, title="Not ours", phase_type=PhaseType.training)
    db.add(foreign)
    await db.flush()

    await client.post(
        f"/admin/studies/{study.id}/participants", json={"ids": ["X-1"]}, headers=admin_headers
    )
    r = await client.post(
        f"/admin/studies/{study.id}/bulk-assign",
        json={
            "participant_ids": ["X-1"],
            "items": [{"video_id": foreign.id, "slot_index": 0, "phase_type": "training"}],
        },
        headers=admin_headers,
    )

    assert r.status_code == 400


async def test_gaze_recordings_are_listed_newest_first(
    client, db, study, videos, seed_participant, admin_headers
):
    for v in videos[:2]:
        db.add(GazeRecording(participant_id=seed_participant.id, video_id=v.id, sample_count=100))
    await db.flush()

    body = (await client.get("/admin/gaze/recordings", headers=admin_headers)).json()

    assert len(body["items"]) == 2
    assert body["items"][0]["participant_id"] == seed_participant.id
    assert body["items"][0]["video_title"] in {"Case 0", "Case 1"}
    assert body["items"][0]["sample_count"] == 100


async def test_gaze_recordings_can_be_filtered(
    client, db, study, videos, seed_participant, admin_headers
):
    db.add(Participant(id="T-009", study_id=study.id))
    await db.flush()
    db.add(GazeRecording(participant_id=seed_participant.id, video_id=videos[0].id))
    db.add(GazeRecording(participant_id="T-009", video_id=videos[0].id))
    await db.flush()

    mine = (
        await client.get(
            "/admin/gaze/recordings", params={"participant_id": "t-001"}, headers=admin_headers
        )
    ).json()
    assert [i["participant_id"] for i in mine["items"]] == ["T-001"]

    by_study = (
        await client.get(
            "/admin/gaze/recordings", params={"study_id": study.id}, headers=admin_headers
        )
    ).json()
    assert len(by_study["items"]) == 2

    elsewhere = (
        await client.get(
            "/admin/gaze/recordings", params={"study_id": 999999}, headers=admin_headers
        )
    ).json()
    assert elsewhere["items"] == []


async def test_the_admin_replay_reports_what_it_could_map(
    client, db, uploads, videos, seed_participant, admin_headers
):
    recording = GazeRecording(
        participant_id=seed_participant.id,
        video_id=videos[0].id,
        sampling_rate_hz=120,
        storage_prefix=str(uploads / "gaze" / seed_participant.id / "1"),
    )
    db.add(recording)
    await db.flush()

    folder = uploads / "gaze" / seed_participant.id / "1"
    folder.mkdir(parents=True)
    (folder / "chunk_000000000.ndjson").write_text(
        '{"ts": 2000, "lx": 0.5, "ly": 0.5, "rx": 0.5, "ry": 0.5}\n'
    )
    db.add(
        InteractionLog(
            participant_id=seed_participant.id,
            video_id=videos[0].id,
            event_type="video_started",
            payload={"currentTime": 0},
            client_ts=1000,
        )
    )
    await db.flush()

    r = await client.get(f"/admin/gaze/recordings/{recording.id}/replay", headers=admin_headers)

    assert r.status_code == 200
    body = r.json()
    assert body["participant_id"] == seed_participant.id
    assert body["video_title"] == "Case 0"
    assert body["video_url"] == "/uploads/videos/c0.mp4"
    assert body["plotted_points"] == 1
    assert body["has_geometry"] is False  # nothing recorded the screen layout
    assert body["points"][0]["t"] == 1000


async def test_replaying_a_recording_that_is_not_there(client, admin_headers):
    r = await client.get("/admin/gaze/recordings/999999/replay", headers=admin_headers)
    assert r.status_code == 404


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/admin/studies/1"),
        ("get", "/admin/studies/1/participants"),
        ("get", "/admin/studies/1/questionnaires"),
        ("get", "/admin/gaze/recordings"),
        ("patch", "/admin/videos/1"),
        ("patch", "/admin/questionnaires/1"),
        ("post", "/admin/studies/1/bulk-assign"),
    ],
)
async def test_none_of_this_is_reachable_as_a_participant(
    client, participant_headers, method, path
):
    kwargs = {"headers": participant_headers}
    if method in ("patch", "post"):
        kwargs["json"] = {}
    r = await getattr(client, method)(path, **kwargs)
    assert r.status_code == 401
