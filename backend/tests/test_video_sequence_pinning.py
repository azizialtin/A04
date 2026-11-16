import csv
import io

import pytest
from sqlalchemy import select

from app.models.enums import PhaseType
from app.models.note import Note
from app.models.participant import Participant
from app.models.session import Session
from app.models.video import Video
from app.models.video_set import VideoSet, VideoSetItem
from app.services.session_script import PILOT_FLOW


async def login(client, participant_id):
    response = await client.post("/auth/participant/login", json={"participant_id": participant_id})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def session(client, headers):
    response = await client.get("/participant/session", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def read_csv(response):
    assert response.status_code == 200, response.text
    return list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))


@pytest.mark.parametrize("flow", ["legacy", PILOT_FLOW])
async def test_default_run_keeps_saved_case_and_replays_after_video_changes(
    client, db, seed_study, seed_participant, admin_headers, flow
):
    seed_study.flow_version = flow
    seed_study.think_aloud_mode = "bundled" if flow == PILOT_FLOW else "block"
    seed_study.think_aloud_count = 3
    # Upload order differs from case order, as it can in the admin.
    videos = [
        Video(study_id=seed_study.id, title=f"Video {i}", phase_type=phase)
        for i, phase in enumerate(
            [PhaseType.post_test, *[PhaseType.training] * 5, PhaseType.pre_test]
        )
    ]
    db.add_all(videos)
    await db.flush()
    headers = await login(client, seed_participant.id)
    before = await session(client, headers)
    post_id = videos[0].id
    saved_index = next(
        i
        for i, step in enumerate(before["steps"])
        if step["kind"] == "case_intro" and step["video_id"] == post_id
    )
    current = await db.scalar(select(Session).where(Session.participant_id == seed_participant.id))
    current.current_step_index = saved_index
    db.add(
        Note(participant_id=seed_participant.id, video_id=post_id, video_time_seconds=1, text="x")
    )
    await db.flush()
    before = await session(client, headers)
    new_video = Video(study_id=seed_study.id, title="Later upload", phase_type=PhaseType.training)
    db.add(new_video)
    await db.flush()
    response = await client.patch(
        f"/admin/videos/{post_id}", json={"phase_type": "pre_test"}, headers=admin_headers
    )
    assert response.status_code == 200

    after = await session(client, headers)
    assert after["steps"] == before["steps"]
    assert after["current_step_index"] == saved_index
    assert after["steps"][saved_index]["video_id"] == post_id
    replays = [step["video_id"] for step in after["steps"] if step["kind"] == "think_aloud"]
    if flow == PILOT_FLOW:
        assert replays == [videos[4].id, videos[5].id, post_id]
    denied = await client.get(f"/participant/videos/{new_video.id}/url", headers=headers)
    assert denied.status_code == 404
    assert denied.json()["detail"] == "That video isn't part of your run."
    exported = read_csv(
        await client.get(f"/admin/studies/{seed_study.id}/export/notes", headers=admin_headers)
    )
    assert (exported[0]["case_number"], exported[0]["phase_type"]) == ("7", "post_test")

    # The new default remains available to participants who have not started.
    later = Participant(id="later-login", study_id=seed_study.id)
    db.add(later)
    await db.flush()
    later_run = await session(client, await login(client, later.id))
    later_cases = [s["video_id"] for s in later_run["steps"] if s["kind"] == "case_video"]
    assert len(later_cases) == 8
    assert later_cases[0] == post_id
    assert new_video.id in later_cases


async def test_empty_run_stays_empty_after_uploads_and_a_filled_set(
    client, db, seed_study, seed_participant, admin_headers
):
    seed_study.flow_version = PILOT_FLOW
    seed_study.think_aloud_mode = "bundled"
    await db.flush()
    headers = await login(client, seed_participant.id)
    before = await session(client, headers)
    video = Video(study_id=seed_study.id, title="Late", phase_type=PhaseType.training)
    video_set = VideoSet(study_id=seed_study.id, name="Late set")
    db.add_all([video, video_set])
    await db.flush()
    db.add(
        VideoSetItem(
            video_set_id=video_set.id, video_id=video.id, slot_index=0, phase_type=video.phase_type
        )
    )
    await db.flush()
    await login(client, seed_participant.id)
    after = await session(client, headers)
    assert after["steps"] == before["steps"]
    assert not any(s["kind"] == "case_video" for s in after["steps"])
    denied = await client.get(f"/participant/videos/{video.id}/url", headers=headers)
    assert denied.status_code == 404
    assert denied.json()["detail"] == "That video isn't part of your run."

    roster = await client.get(f"/admin/studies/{seed_study.id}/stats", headers=admin_headers)
    assert roster.status_code == 200, roster.text
    assert roster.json()["roster"][0]["cases"] == 0
    assert roster.json()["roster"][0]["total_steps"] == len(before["steps"])
    detail = await client.get(
        f"/admin/participants/{seed_participant.id}/stats", headers=admin_headers
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["cases"] == []

    # Imported stray data must not acquire a case number from a later upload.
    db.add(
        Note(participant_id=seed_participant.id, video_id=video.id, video_time_seconds=1, text="x")
    )
    await db.flush()
    exported = read_csv(
        await client.get(f"/admin/studies/{seed_study.id}/export/notes", headers=admin_headers)
    )
    assert exported[0]["case_number"] == ""


async def test_copied_default_video_cannot_be_deleted(
    client, db, seed_study, seed_participant, admin_headers
):
    video = Video(study_id=seed_study.id, title="Required", phase_type=PhaseType.training)
    db.add(video)
    await db.flush()
    video_id = video.id
    headers = await login(client, seed_participant.id)
    before = await session(client, headers)
    response = await client.delete(f"/admin/videos/{video_id}", headers=admin_headers)
    assert response.status_code == 409
    assert (await session(client, headers))["steps"] == before["steps"]
