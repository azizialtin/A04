"""Cross-route regressions for independently found data-integrity gaps."""

import csv
import io
import re
import warnings

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

from app.core.config import get_settings
from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.models.study import Study
from app.models.video import Video
from app.services.session_script import build_steps
from main import app


@pytest_asyncio.fixture
async def boundary_data(db, seed_study, seed_participant):
    other = Study(name="Other study")
    db.add(other)
    await db.flush()
    own, spare, foreign = [
        Video(study_id=study_id, title=title, phase_type=PhaseType.training)
        for study_id, title in (
            (seed_study.id, "Assigned"),
            (seed_study.id, "Unassigned"),
            (other.id, "Foreign stimulus"),
        )
    ]
    question = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="Required PCK",
        section_key="pck",
        questions=[{"id": "answer", "type": "free_text", "text": "Why?", "required": True}],
    )
    seed_participant.status = ParticipantStatus.active
    seed_participant.video_sequence_pinned = True
    db.add_all([own, spare, foreign, question, Session(participant_id=seed_participant.id)])
    await db.flush()
    db.add(
        ParticipantVideo(
            participant_id=seed_participant.id,
            video_id=own.id,
            slot_index=0,
            phase_type=own.phase_type,
        )
    )
    await db.flush()
    return own, spare, foreign, question


async def test_every_protected_operation_rejects_missing_and_wrong_role_tokens(
    client, participant_headers, admin_headers
):
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Duplicate Operation ID")
        paths = app.openapi()["paths"]
    checked = 0
    for path, operations in paths.items():
        if not path.startswith(("/admin/", "/participant/", "/gaze/", "/screen/")):
            continue
        url = re.sub(r"\{[^}]+\}", "1", path)
        for method in operations:
            if method not in {"get", "post", "put", "patch", "delete", "head"}:
                continue
            wrong_role = participant_headers if path.startswith("/admin/") else admin_headers
            for headers in ({}, wrong_role):
                response = await client.request(method.upper(), url, headers=headers, json={})
                assert response.status_code == 401, (
                    method,
                    path,
                    response.status_code,
                    response.text,
                )
                checked += 1
    assert checked >= 130


@pytest.mark.parametrize("case", ["spare", "foreign"])
async def test_participant_case_routes_reject_unassigned_and_foreign_videos(
    client, boundary_data, participant_headers, case, monkeypatch
):
    _, spare, foreign, _ = boundary_data
    video = spare if case == "spare" else foreign
    monkeypatch.setattr(get_settings(), "SCREEN_RECORDING_ENABLED", True)
    requests = [
        ("GET", f"/participant/videos/{video.id}/url", None),
        ("GET", f"/participant/videos/{video.id}/notes", None),
        ("GET", f"/gaze/videos/{video.id}/replay", None),
        (
            "POST",
            "/participant/notes",
            {"video_id": video.id, "text": "x", "video_time_seconds": 1},
        ),
        ("POST", "/participant/diagnosis", {"video_id": video.id, "text": "x"}),
        ("POST", "/participant/events", {"video_id": video.id, "event_type": "video_play"}),
        ("POST", "/gaze/recordings", {"video_id": video.id, "sampling_rate_hz": 120}),
        ("POST", "/screen/recordings", {"video_id": video.id}),
    ]
    for method, url, body in requests:
        response = await client.request(method, url, headers=participant_headers, json=body)
        assert response.status_code == 404, (method, url, response.status_code, response.text)


async def test_events_cannot_attach_foreign_study_videos(
    client,
    db,
    boundary_data,
    participant_headers,
    seed_participant,
    seed_study,
    admin_headers,
):
    _, _, foreign, _ = boundary_data

    response = await client.post(
        "/participant/events",
        headers=participant_headers,
        json={"event_type": "video_started", "video_id": foreign.id, "client_ts": 1000},
    )
    rows = list(
        (
            await db.scalars(
                select(InteractionLog).where(InteractionLog.participant_id == seed_participant.id)
            )
        ).all()
    )
    export = await client.get(
        f"/admin/studies/{seed_study.id}/export/events", headers=admin_headers
    )
    exported = list(csv.DictReader(io.StringIO(export.content.decode("utf-8-sig"))))
    assert response.status_code == 404 and rows == [] and exported == [], (
        response.status_code,
        [(r.video_id, r.event_type) for r in rows],
        exported,
    )


async def test_failed_event_storage_is_not_acknowledged_as_delivered(
    client, db, boundary_data, participant_headers, monkeypatch
):
    await db.commit()

    async def fail_commit():
        raise OperationalError("COMMIT", {}, ConnectionError("Storage unavailable"))

    monkeypatch.setattr(db, "commit", fail_commit)
    own, _, _, _ = boundary_data
    response = await client.post(
        "/participant/events",
        headers=participant_headers,
        json={"event_type": "video_started", "video_id": own.id, "client_ts": 1000},
    )
    count = await db.scalar(select(func.count()).select_from(InteractionLog))
    assert response.status_code >= 500 and count == 0, (response.status_code, count)


async def test_event_writer_persists_the_original_clock_and_payload(
    client, db, boundary_data, participant_headers, seed_participant, monkeypatch
):
    own, _, _, _ = boundary_data
    payload = {"video_time_seconds": 3.25, "playback_rate": 1}
    response = await client.post(
        "/participant/events",
        headers=participant_headers,
        json={
            "event_type": "video_started",
            "video_id": own.id,
            "client_ts": 1000,
            "payload": payload,
        },
    )
    assert response.status_code == 202
    row = await db.scalar(select(InteractionLog))
    assert (row.participant_id, row.video_id, row.event_type, row.client_ts, row.payload) == (
        seed_participant.id,
        own.id,
        "video_started",
        1000,
        payload,
    )


@pytest.mark.parametrize("flow", ["legacy", "pilot_20261116"])
async def test_required_pck_cannot_be_skipped_by_generic_progress(
    client, db, boundary_data, participant_headers, seed_participant, seed_study, flow
):
    seed_study.flow_version = flow
    seed_study.think_aloud_mode = "bundled" if flow == "pilot_20261116" else "block"
    await db.flush()
    _, _, _, page = boundary_data
    steps = await build_steps(db, seed_participant)
    session = await db.scalar(select(Session).where(Session.participant_id == seed_participant.id))
    session.current_step_index = next(
        i for i, s in enumerate(steps) if s.get("questionnaire_id") == page.id
    )
    await db.flush()
    response = await client.patch(
        "/participant/session/progress",
        headers=participant_headers,
        json={"current_step_index": len(steps), "expected_step_index": session.current_step_index},
    )
    count = await db.scalar(select(func.count()).select_from(QuestionnaireResponse))
    assert response.status_code == 409 and count == 0 and session.completed_at is None, (
        response.status_code,
        count,
        session.current_step_index,
        session.completed_at,
    )


async def test_retried_note_snapshot_is_saved_once(client, db, boundary_data, participant_headers):
    own, _, _, _ = boundary_data
    body = {"video_id": own.id, "text": "Draft", "video_time_seconds": 5, "client_ts": 1000}
    replies = [
        await client.post("/participant/notes", headers=participant_headers, json=body)
        for _ in range(2)
    ]
    assert all(r.status_code == 201 for r in replies)
    count = await db.scalar(select(func.count()).select_from(Note))
    assert count == 1, ([r.json() for r in replies], count)


async def test_negative_diagnosis_duration_is_rejected(client, boundary_data, participant_headers):
    own, _, _, _ = boundary_data
    response = await client.post(
        "/participant/diagnosis",
        headers=participant_headers,
        json={"video_id": own.id, "text": "Diagnosis", "time_spent_seconds": -7},
    )
    assert response.status_code == 422, (response.status_code, response.text)


@pytest.mark.parametrize(
    "raw_rate", ["1e309", "-1e309", "NaN", "Infinity", "0", "0.5", "-1", "2147483648"]
)
async def test_nonfinite_or_unstorable_gaze_rate_is_a_validation_error(
    client, boundary_data, participant_headers, raw_rate
):
    own, _, _, _ = boundary_data
    async with AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test"
    ) as probe:
        response = await probe.post(
            "/gaze/recordings",
            headers={**participant_headers, "Content-Type": "application/json"},
            content='{"video_id":' + str(own.id) + ',"sampling_rate_hz":' + raw_rate + "}",
        )
    assert response.status_code == 422, (response.status_code, response.text)


@pytest.mark.parametrize("duration", [None, 0, 60])
async def test_valid_diagnosis_durations_are_preserved(
    client, db, boundary_data, participant_headers, duration
):
    from app.models.text_entry import TextEntry

    own, _, _, _ = boundary_data
    response = await client.post(
        "/participant/diagnosis",
        headers=participant_headers,
        json={"video_id": own.id, "text": "Diagnosis", "time_spent_seconds": duration},
    )
    assert response.status_code == 201
    assert (await db.get(TextEntry, response.json()["id"])).time_spent_seconds == duration
