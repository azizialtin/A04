"""Every export kind, and that streaming one does not truncate it."""

import csv
import io

import pytest_asyncio

from app.models.enums import PhaseType
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.text_entry import TextEntry
from app.models.video import Video

# Everything keyed by participant, which is every export but the video list.
KINDS = ["participants", "notes", "diagnoses", "responses", "events", "gaze", "calibration"]
ALL_KINDS = [*KINDS, "videos"]


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
    for kind in ALL_KINDS:
        r = await client.get(f"/admin/studies/{seed_study.id}/export/{kind}", headers=admin_headers)
        assert r.status_code == 200
        assert read(r) == [], kind
        first = "video_id" if kind == "videos" else "participant_id"
        assert r.content.decode("utf-8-sig").strip().startswith(first), kind


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


async def test_playback_times_are_readable_as_well_as_exact(client, db, data, admin_headers):
    # The line a researcher asked about: a seek, logged in fractional seconds.
    db.add(
        InteractionLog(
            participant_id="T-001",
            video_id=data["video"].id,
            event_type="video_seeked",
            payload={"to": 65.5, "from": 0.719483, "currentTime": 65.5},
        )
    )
    await db.flush()

    rows = read(
        await client.get(f"/admin/studies/{data['study'].id}/export/events", headers=admin_headers)
    )
    seek = next(r for r in rows if r["event_type"] == "video_seeked")
    assert (seek["video_time_from"], seek["video_time"]) == ("00:00", "01:05")
    # And the exact figures are still there to compute with.
    assert '"from": 0.719483' in seek["payload"]


async def test_a_progress_row_names_the_screen_that_was_finished(client, db, data, admin_headers):
    db.add(
        InteractionLog(
            participant_id="T-001",
            event_type="progress_update",
            payload={
                "current_step_index": 2,
                "total_steps": 12,
                "complete": False,
                "completed_step": {
                    "index": 1,
                    "kind": "questionnaire",
                    "title": "Angaben zur Person",
                    "page": 1,
                    "page_count": 3,
                },
            },
        )
    )
    await db.flush()

    rows = read(
        await client.get(f"/admin/studies/{data['study'].id}/export/events", headers=admin_headers)
    )
    progress = next(r for r in rows if r["event_type"] == "progress_update")
    assert progress["completed_step"] == "questionnaire: Angaben zur Person (page 1/3)"
    # Playback columns stay empty on a row that is not about the clip.
    assert progress["video_time"] == ""


async def test_the_video_export_is_what_every_video_id_points_at(client, data, admin_headers):
    rows = read(
        await client.get(f"/admin/studies/{data['study'].id}/export/videos", headers=admin_headers)
    )
    assert rows[0]["video_id"] == str(data["video"].id)
    assert rows[0]["title"] == "V"
    assert rows[0]["phase_type"] == "pre_test"


async def test_the_catalogue_counts_every_export(client, data, admin_headers):
    r = await client.get(f"/admin/studies/{data['study'].id}/exports", headers=admin_headers)
    assert r.status_code == 200
    by_kind = {row["kind"]: row for row in r.json()}

    assert set(by_kind) == set(ALL_KINDS)
    assert by_kind["notes"] == {
        "kind": "notes",
        "filename": "notes.csv",
        "rows": 1,
        "collected": True,
    }
    # An empty calibration file is the expected shape of a study calibrated in
    # Eye Tracker Manager rather than in the app, and the tab has to say so.
    assert by_kind["calibration"]["collected"] is False


async def test_the_catalogue_is_admin_only(client, data, participant_headers):
    r = await client.get(f"/admin/studies/{data['study'].id}/exports", headers=participant_headers)
    assert r.status_code == 401


PER_CASE_KINDS = ["notes", "diagnoses", "responses", "events", "gaze"]


async def test_every_per_case_file_says_which_case_the_row_belongs_to(
    client, db, data, seed_participant, admin_headers
):
    # T-001's run: another clip first, then the fixture's clip — so the
    # fixture's rows are the *second* case, whatever its database id says.
    other = Video(study_id=data["study"].id, title="W", phase_type=PhaseType.training)
    db.add(other)
    await db.flush()
    db.add_all(
        [
            ParticipantVideo(
                participant_id=seed_participant.id,
                video_id=other.id,
                slot_index=0,
                phase_type=PhaseType.training,
            ),
            # The slot's phase is what the participant was shown. Here it
            # differs from the clip's own, and the export follows the slot.
            ParticipantVideo(
                participant_id=seed_participant.id,
                video_id=data["video"].id,
                slot_index=1,
                phase_type=PhaseType.post_test,
            ),
        ]
    )
    await db.flush()

    for kind in PER_CASE_KINDS:
        rows = read(
            await client.get(
                f"/admin/studies/{data['study'].id}/export/{kind}", headers=admin_headers
            )
        )
        row = rows[0]
        assert row["video_id"] == str(data["video"].id), kind
        assert row["case_number"] == "2", kind
        assert row["phase_type"] == "post_test", kind
        assert row["video_title"] == "V", kind
        # Right after video_id, where someone filtering by case looks first.
        columns = list(row)
        at = columns.index("video_id")
        assert columns[at + 1 : at + 4] == ["case_number", "phase_type", "video_title"], kind


async def test_a_run_on_the_study_default_order_is_numbered_like_the_script(
    client, db, seed_study, seed_participant, admin_headers
):
    # Uploaded in the wrong order on purpose. The script still shows them
    # pre-test, training, post-test, and the export has to count the same way.
    training = Video(study_id=seed_study.id, title="Training", phase_type=PhaseType.training)
    post = Video(study_id=seed_study.id, title="Post", phase_type=PhaseType.post_test)
    pre = Video(study_id=seed_study.id, title="Pre", phase_type=PhaseType.pre_test)
    db.add_all([training, post, pre])
    await db.flush()
    db.add_all(
        InteractionLog(
            participant_id=seed_participant.id,
            video_id=v.id,
            event_type="video_started",
            payload={},
        )
        for v in (training, post, pre)
    )
    await db.flush()

    login = await client.post("/auth/participant/login", json={"participant_id": "T-001"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    script = (await client.get("/participant/session", headers=headers)).json()
    scripted = [s["video_id"] for s in script["steps"] if s["kind"] == "case_video"]
    assert scripted == [pre.id, training.id, post.id]

    rows = read(
        await client.get(f"/admin/studies/{seed_study.id}/export/events", headers=admin_headers)
    )
    numbered = {int(r["video_id"]): int(r["case_number"]) for r in rows if r["video_id"]}
    assert numbered == {vid: i + 1 for i, vid in enumerate(scripted)}
    phases = {r["video_id"]: r["phase_type"] for r in rows if r["video_id"]}
    assert phases == {
        str(pre.id): "pre_test",
        str(training.id): "training",
        str(post.id): "post_test",
    }


async def test_rows_without_a_case_leave_the_case_columns_empty(client, db, data, admin_headers):
    page = Questionnaire(
        study_id=data["study"].id, placement="pre_test", title="Angaben zur Person"
    )
    db.add(page)
    await db.flush()
    db.add_all(
        [
            InteractionLog(participant_id="T-001", event_type="login", payload={}),
            QuestionnaireResponse(
                questionnaire_id=page.id, participant_id="T-001", video_id=None, answers={"age": 30}
            ),
        ]
    )
    await db.flush()

    events = read(
        await client.get(f"/admin/studies/{data['study'].id}/export/events", headers=admin_headers)
    )
    login = next(r for r in events if r["event_type"] == "login")
    assert (login["case_number"], login["phase_type"], login["video_title"]) == ("", "", "")

    responses = read(
        await client.get(
            f"/admin/studies/{data['study'].id}/export/responses", headers=admin_headers
        )
    )
    pre_test = next(r for r in responses if r["placement"] == "pre_test")
    assert (pre_test["case_number"], pre_test["phase_type"], pre_test["video_title"]) == (
        "",
        "",
        "",
    )
