"""Every export kind, and that streaming one does not truncate it."""

import csv
import io

import pytest_asyncio

from app.models.enums import PhaseType
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.text_entry import TextEntry
from app.models.video import Video

KINDS = ["notes", "diagnoses", "responses", "events", "gaze", "calibration"]


def read(response) -> list[dict]:
    body = response.content.decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(body)))


@pytest_asyncio.fixture
async def data(db, seed_study, seed_participant):
    video = Video(study_id=seed_study.id, title="V", phase_type=PhaseType.pre_test)
    questionnaire = Questionnaire(
        study_id=seed_study.id, placement="case_outro", title="Nach dem Fall"
    )
    db.add_all([video, questionnaire])
    await db.flush()

    pid = seed_participant.id
    db.add_all(
        [
            Note(participant_id=pid, video_id=video.id, video_time_seconds=4.5, text="a note"),
            TextEntry(
                participant_id=pid,
                video_id=video.id,
                kind="diagnosis",
                text="the loop runs once too often",
                time_spent_seconds=93,
            ),
            QuestionnaireResponse(
                questionnaire_id=questionnaire.id,
                participant_id=pid,
                video_id=video.id,
                answers={"c": 4},
                time_spent_seconds=17,
            ),
            InteractionLog(
                participant_id=pid,
                video_id=video.id,
                event_type="video_started",
                payload={"currentTime": 0},
                client_ts=1_755_000_000_123,
            ),
            GazeRecording(
                participant_id=pid, video_id=video.id, sampling_rate_hz=120, sample_count=4200
            ),
            GazeCalibration(
                participant_id=pid, status="success", mean_offset=0.012, mean_offset_degrees=0.61
            ),
        ]
    )
    await db.flush()
    return {"study": seed_study, "video": video, "questionnaire": questionnaire}


async def test_every_kind_exports_its_row(client, data, admin_headers):
    for kind in KINDS:
        r = await client.get(
            f"/admin/studies/{data['study'].id}/export/{kind}", headers=admin_headers
        )
        assert r.status_code == 200, kind
        rows = read(r)
        assert len(rows) == 1, kind
        assert rows[0]["participant_id"] == "T-001", kind


async def test_the_columns_researchers_asked_for_are_there(client, data, admin_headers):
    study_id = data["study"].id

    diagnoses = read(
        await client.get(f"/admin/studies/{study_id}/export/diagnoses", headers=admin_headers)
    )
    assert diagnoses[0]["text"] == "the loop runs once too often"
    assert diagnoses[0]["time_spent_seconds"] == "93"

    responses = read(
        await client.get(f"/admin/studies/{study_id}/export/responses", headers=admin_headers)
    )
    assert responses[0]["answers"] == '{"c": 4}'
    assert responses[0]["time_spent_seconds"] == "17"
    # Which battery this was, without having to join back to the questionnaire.
    assert responses[0]["placement"] == "case_outro"
    assert responses[0]["questionnaire_title"] == "Nach dem Fall"

    events = read(
        await client.get(f"/admin/studies/{study_id}/export/events", headers=admin_headers)
    )
    assert events[0]["client_ts"] == "1755000000123"
    # The name this event carries in the study's data dictionary.
    assert events[0]["variable_name"] == "click_event_play"

    calibration = read(
        await client.get(f"/admin/studies/{study_id}/export/calibration", headers=admin_headers)
    )
    assert calibration[0]["status"] == "success"
    assert calibration[0]["mean_offset_degrees"] == "0.61"


async def test_an_unknown_kind_is_404(client, data, admin_headers):
    r = await client.get(f"/admin/studies/{data['study'].id}/export/wishes", headers=admin_headers)
    assert r.status_code == 404


async def test_an_empty_study_exports_just_its_header(client, seed_study, admin_headers):
    for kind in KINDS:
        r = await client.get(f"/admin/studies/{seed_study.id}/export/{kind}", headers=admin_headers)
        assert r.status_code == 200
        assert read(r) == [], kind
        assert r.content.decode("utf-8-sig").strip().startswith("participant_id")


async def test_streaming_does_not_truncate_a_large_export(
    client, db, data, seed_participant, admin_headers
):
    # Comfortably past the 500-row cursor batch and the 64 KB flush threshold.
    db.add_all(
        [
            Note(
                participant_id=seed_participant.id,
                video_id=data["video"].id,
                video_time_seconds=float(i),
                text=f"note {i} " + "x" * 200,
            )
            for i in range(2000)
        ]
    )
    await db.flush()

    r = await client.get(f"/admin/studies/{data['study'].id}/export/notes", headers=admin_headers)
    rows = read(r)

    assert len(rows) == 2001  # the fixture's note plus these
    assert rows[-1]["text"].startswith("note 1999")


async def test_the_export_is_offered_as_a_download(client, data, admin_headers):
    r = await client.get(f"/admin/studies/{data['study'].id}/export/notes", headers=admin_headers)
    assert r.headers["content-disposition"] == 'attachment; filename="notes.csv"'
    assert r.headers["content-type"].startswith("text/csv")


async def test_exports_are_admin_only(client, data, participant_headers):
    r = await client.get(
        f"/admin/studies/{data['study'].id}/export/notes", headers=participant_headers
    )
    assert r.status_code == 401
