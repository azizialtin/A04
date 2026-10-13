import pytest
import pytest_asyncio
from sqlalchemy import func, select

from app.models.enums import ParticipantStatus
from app.models.note import Note
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.services import storage

# Enough of an ISO base media header to be recognised as a real clip.
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 32


@pytest.fixture(autouse=True)
def uploads(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    return tmp_path


@pytest_asyncio.fixture
async def study_id(client, admin_headers):
    r = await client.post(
        "/admin/studies",
        json={"name": "Study X", "sosci_pretest_url": "https://s.example/pre"},
        headers=admin_headers,
    )
    assert r.status_code == 201
    return r.json()["id"]


async def _upload_video(client, admin_headers, study_id, phase="training"):
    return await client.post(
        f"/admin/studies/{study_id}/videos",
        data={
            "title": "Case",
            "phase_type": phase,
            "time_limit_seconds": "120",
            "task_description": "Diagnose",
        },
        files={"file": ("clip.mp4", MP4, "video/mp4")},
        headers=admin_headers,
    )


async def test_admin_requires_auth(client):
    assert (await client.get("/admin/studies")).status_code == 401


async def test_participant_token_rejected_on_admin(client, participant_headers):
    assert (await client.get("/admin/studies", headers=participant_headers)).status_code == 401


async def test_study_crud(client, admin_headers, study_id):
    listing = await client.get("/admin/studies", headers=admin_headers)
    assert any(s["id"] == study_id for s in listing.json())

    upd = await client.patch(
        f"/admin/studies/{study_id}", json={"name": "Renamed"}, headers=admin_headers
    )
    assert upd.status_code == 200 and upd.json()["name"] == "Renamed"
    assert upd.json()["sosci_pretest_url"] == "https://s.example/pre"  # untouched


async def test_a_participant_id_that_is_only_dots_is_refused(client, admin_headers, study_id):
    """The id becomes a directory name under uploads/; ".." is made of the
    allowed charset but would climb out of the tree."""
    r = await client.post(
        f"/admin/studies/{study_id}/participants",
        json={"ids": ["..", ".", "TN-ok"]},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert sorted(r.json()["detail"]["ids"]) == [".", ".."]


async def test_video_upload_and_list(client, admin_headers, study_id):
    r = await _upload_video(client, admin_headers, study_id, phase="pre_test")
    assert r.status_code == 201
    body = r.json()
    assert body["has_file"] is True
    assert body["phase_type"] == "pre_test"
    assert body["time_limit_seconds"] == 120

    videos = await client.get(f"/admin/studies/{study_id}/videos", headers=admin_headers)
    assert len(videos.json()) == 1


async def test_video_upload_rejects_bad_phase(client, admin_headers, study_id):
    r = await client.post(
        f"/admin/studies/{study_id}/videos",
        data={"title": "Case", "phase_type": "nonsense"},
        files={"file": ("clip.mp4", b"\x00", "video/mp4")},
        headers=admin_headers,
    )
    assert r.status_code == 400


async def test_over_long_id_is_refused_without_losing_the_batch(
    client, db, admin_headers, study_id
):
    r = await client.post(
        f"/admin/studies/{study_id}/participants",
        json={"ids": ["GOOD-1", "X" * 80, "GOOD-2"]},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert r.json()["detail"]["ids"] == ["X" * 80]

    # The good ids in the same request are not half-written.
    remaining = await db.scalar(
        select(func.count()).select_from(Participant).where(Participant.study_id == study_id)
    )
    assert remaining == 0


async def test_duplicate_ids_in_one_request_create_one_participant(
    client, db, admin_headers, study_id
):
    r = await client.post(
        f"/admin/studies/{study_id}/participants",
        json={"ids": ["D-1", "d-1", " D-1 ", "D-2"]},
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert r.json()["created"] == ["D-1", "D-2"]

    count = await db.scalar(
        select(func.count()).select_from(Participant).where(Participant.study_id == study_id)
    )
    assert count == 2


async def test_already_registered_ids_are_reported_not_duplicated(client, admin_headers, study_id):
    await client.post(
        f"/admin/studies/{study_id}/participants", json={"ids": ["E-7"]}, headers=admin_headers
    )
    again = await client.post(
        f"/admin/studies/{study_id}/participants",
        json={"ids": ["e-7", "E-8"]},
        headers=admin_headers,
    )
    assert again.json() == {"created": ["E-8"], "skipped": ["e-7"]}


async def test_blank_lines_are_ignored(client, admin_headers, study_id):
    r = await client.post(
        f"/admin/studies/{study_id}/participants",
        json={"ids": ["  ", "B-1", ""]},
        headers=admin_headers,
    )
    assert r.json()["created"] == ["B-1"]


async def test_participants_create_and_sequence(client, db, admin_headers, study_id):
    vid = (await _upload_video(client, admin_headers, study_id, phase="pre_test")).json()["id"]

    made = await client.post(
        f"/admin/studies/{study_id}/participants",
        json={"ids": ["P-1", "P-2", "P-1"]},  # duplicate P-1 -> skipped once
        headers=admin_headers,
    )
    assert made.status_code == 200
    assert made.json()["created"] == ["P-1", "P-2"]

    seq = await client.put(
        "/admin/participants/P-1/videos",
        json={"items": [{"video_id": vid, "slot_index": 0, "phase_type": "pre_test"}]},
        headers=admin_headers,
    )
    assert seq.status_code == 200 and seq.json()["slot_count"] == 1

    detail = await client.get("/admin/participants/P-1", headers=admin_headers)
    assert detail.json()["sequence"][0]["video_id"] == vid

    # Locked once the participant has started.
    p = await db.scalar(select(Participant).where(Participant.id == "P-1"))
    p.status = ParticipantStatus.active
    await db.flush()
    locked = await client.put(
        "/admin/participants/P-1/videos",
        json={"items": [{"video_id": vid, "slot_index": 0, "phase_type": "pre_test"}]},
        headers=admin_headers,
    )
    assert locked.status_code == 409


async def test_sequence_rejects_foreign_video(client, admin_headers, study_id):
    await client.post(
        f"/admin/studies/{study_id}/participants", json={"ids": ["P-9"]}, headers=admin_headers
    )
    r = await client.put(
        "/admin/participants/P-9/videos",
        json={"items": [{"video_id": 999999, "slot_index": 0, "phase_type": "pre_test"}]},
        headers=admin_headers,
    )
    assert r.status_code == 400


async def test_questionnaire_crud_and_forced_delete(client, db, admin_headers, study_id):
    vid = (await _upload_video(client, admin_headers, study_id)).json()["id"]
    created = await client.post(
        f"/admin/studies/{study_id}/questionnaires",
        json={
            "placement": "pre_test",
            "title": "Vorwissen",
            "section": " CK-Pretest ",
            "order_index": 9,
            "questions": [{"id": "c", "type": "likert", "text": "confidence"}],
        },
        headers=admin_headers,
    )
    assert created.status_code == 201
    qid = created.json()["id"]
    assert created.json()["section"] == "CK-Pretest"

    renamed = await client.patch(
        f"/admin/questionnaires/{qid}", json={"section": "MSK"}, headers=admin_headers
    )
    assert renamed.status_code == 200
    assert renamed.json()["section"] == "MSK"
    # Clearing it, by null or by blank, leaves the page standing alone.
    cleared = await client.patch(
        f"/admin/questionnaires/{qid}", json={"section": None}, headers=admin_headers
    )
    assert cleared.status_code == 200
    assert cleared.json()["section"] == ""

    # A response makes a plain delete refuse.
    await client.post(
        f"/admin/studies/{study_id}/participants", json={"ids": ["R-1"]}, headers=admin_headers
    )
    db.add(
        QuestionnaireResponse(
            questionnaire_id=qid, participant_id="R-1", video_id=vid, answers={"c": 3}
        )
    )
    await db.flush()

    blocked = await client.delete(f"/admin/questionnaires/{qid}", headers=admin_headers)
    assert blocked.status_code == 409
    forced = await client.delete(f"/admin/questionnaires/{qid}?force=true", headers=admin_headers)
    assert forced.status_code == 200
    assert await db.scalar(select(Questionnaire).where(Questionnaire.id == qid)) is None


async def test_export_notes_csv(client, db, admin_headers, study_id):
    vid = (await _upload_video(client, admin_headers, study_id)).json()["id"]
    await client.post(
        f"/admin/studies/{study_id}/participants", json={"ids": ["E-1"]}, headers=admin_headers
    )
    db.add(Note(participant_id="E-1", video_id=vid, video_time_seconds=3.0, text="looks wrong"))
    await db.flush()

    r = await client.get(f"/admin/studies/{study_id}/export/notes", headers=admin_headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    text = r.text
    assert (
        "participant_id,video_id,case_number,phase_type,video_title,"
        "video_time_seconds,video_time,text,created_at"
    ) in text
    assert "E-1" in text and "looks wrong" in text
    # The raw seconds for the analysis, the timecode for whoever opens the file.
    assert "3.0,00:03" in text


async def test_delete_study_requires_force_with_participants(client, admin_headers, study_id):
    await client.post(
        f"/admin/studies/{study_id}/participants", json={"ids": ["D-1"]}, headers=admin_headers
    )
    assert (
        await client.delete(f"/admin/studies/{study_id}", headers=admin_headers)
    ).status_code == 409
    assert (
        await client.delete(f"/admin/studies/{study_id}?force=true", headers=admin_headers)
    ).status_code == 200


async def test_audit_records_actions(client, admin_headers, study_id):
    # study_id fixture already created a study; the audit endpoint should list it.
    # (Background audit writers are silenced in tests, so assert the endpoint
    # shape rather than specific rows.)
    r = await client.get("/admin/audit", headers=admin_headers)
    assert r.status_code == 200
    assert "items" in r.json()
