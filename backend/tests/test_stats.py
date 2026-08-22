"""The statistics the admin dashboard reads a study by.

Most of it is counting, and counting is only interesting where it can be wrong:
the spans reconstructed from the event log, the denominators a completion rate
is a fraction of, and the arithmetic step count that stands in for building
every participant's script.
"""

from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio

from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.screen_recording import ScreenRecording
from app.models.session import Session
from app.models.text_entry import TextEntry
from app.models.video import Video
from app.services.session_script import build_steps, count_steps
from app.services.stats import median, rate, summarise_case

T0 = 1_700_000_000_000  # a round epoch-ms to hang the event clock off


class Ev:
    """The duck type the span reconstruction reads — an event row, minus the row."""

    def __init__(self, event_type, ts, current_time=0.0, video_id=1, participant_id="P"):
        self.event_type = event_type
        self.client_ts = ts
        self.created_at = datetime.fromtimestamp(ts / 1000, UTC)
        self.payload = {"currentTime": current_time}
        self.video_id = video_id
        self.participant_id = participant_id


# --- the spans SQL cannot count ------------------------------------------


def test_watch_time_is_the_clip_playing_not_the_screen_being_open():
    summary = summarise_case(
        [
            Ev("case_screen_entered", T0),
            Ev("video_started", T0 + 5_000, 0.0),
            Ev("video_paused", T0 + 15_000, 10.0),
            # Ten seconds of the clip, forty of the screen: the gap is the
            # participant reading the task and typing notes.
            Ev("case_screen_exited", T0 + 45_000),
        ]
    )

    assert summary["watch_seconds"] == 10.0
    assert summary["on_screen_seconds"] == 45.0
    assert summary["max_playhead_seconds"] == 10.0
    assert summary["play_spans"] == 1


def test_a_pause_and_a_resume_are_one_stretch_of_watching_each():
    summary = summarise_case(
        [
            Ev("video_started", T0, 0.0),
            Ev("video_paused", T0 + 10_000, 10.0),
            Ev("video_resumed", T0 + 30_000, 10.0),
            Ev("video_completed", T0 + 40_000, 20.0),
        ]
    )

    assert summary["watch_seconds"] == 20.0
    assert summary["play_spans"] == 2


def test_rewatching_a_stretch_does_not_inflate_how_far_they_got():
    summary = summarise_case(
        [
            Ev("video_started", T0, 0.0),
            Ev("video_paused", T0 + 60_000, 60.0),
            Ev("video_seeked", T0 + 61_000, 10.0),
            Ev("video_resumed", T0 + 62_000, 10.0),
            Ev("video_paused", T0 + 72_000, 20.0),
        ]
    )

    assert summary["watch_seconds"] == 70.0
    # They watched 70s of clip but only ever reached 60s into it.
    assert summary["max_playhead_seconds"] == 60.0


def test_a_case_left_open_is_closed_at_the_last_thing_we_saw():
    # A browser closed mid-clip: without a bound the open span runs to infinity.
    summary = summarise_case(
        [
            Ev("case_screen_entered", T0),
            Ev("video_started", T0 + 1_000, 0.0),
            Ev("notes_focused", T0 + 21_000),
        ]
    )

    assert summary["watch_seconds"] == 20.0
    assert summary["on_screen_seconds"] == 21.0


def test_a_case_with_no_events_is_zero_rather_than_missing():
    assert summarise_case([])["watch_seconds"] == 0.0


def test_median_ignores_the_one_session_that_ran_all_afternoon():
    assert median([10, 12, 14, 400]) == 13.0
    assert median([10, 12, 14]) == 12.0
    assert median([]) is None


def test_a_rate_with_no_denominator_is_unknown_not_zero():
    assert rate(0, 0) is None
    assert rate(1, 4) == 25.0


# --- the step count that stands in for building every script --------------


@pytest.mark.parametrize("calibration", [True, False])
async def test_the_arithmetic_step_count_matches_the_script_it_stands_in_for(
    db, seed_study, seed_participant, calibration, monkeypatch
):
    from app.core import config

    monkeypatch.setattr(config.get_settings(), "CALIBRATION_ENABLED", calibration, raising=False)
    db.add(
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title="Demographics",
            questions=[{"id": "age", "type": "number", "label": "Age"}],
        )
    )
    phases = [PhaseType.pre_test, PhaseType.training, PhaseType.training, PhaseType.post_test]
    for i, phase in enumerate(phases):
        video = Video(study_id=seed_study.id, title=f"C{i}", phase_type=phase)
        db.add(video)
        await db.flush()
        db.add(
            ParticipantVideo(
                participant_id=seed_participant.id,
                video_id=video.id,
                slot_index=i,
                phase_type=phase,
            )
        )
    await db.flush()

    steps = await build_steps(db, seed_participant)

    assert count_steps(1, phases, calibration) == len(steps)


# --- the endpoints --------------------------------------------------------


@pytest_asyncio.fixture
async def run(db, seed_study, seed_participant):
    """One participant most of the way through a two-case study, with a note, a
    diagnosis, an answered battery, gaze, a screen capture and a calibration."""
    videos = []
    for i, phase in enumerate([PhaseType.pre_test, PhaseType.training]):
        v = Video(
            study_id=seed_study.id,
            title=f"Case {i}",
            phase_type=phase,
            gcp_filename=f"c{i}.mp4",
            duration_seconds=120.0,
        )
        db.add(v)
        videos.append(v)
    await db.flush()

    for i, v in enumerate(videos):
        db.add(
            ParticipantVideo(
                participant_id=seed_participant.id,
                video_id=v.id,
                slot_index=i,
                phase_type=v.phase_type,
            )
        )

    battery = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Outro",
        questions=[{"id": "q1", "type": "likert", "label": "?"}],
    )
    db.add(battery)
    seed_participant.status = ParticipantStatus.active
    db.add(Session(participant_id=seed_participant.id, current_step_index=6))
    await db.flush()

    first = videos[0]
    for event_type, offset, current in [
        ("case_screen_entered", 0, 0.0),
        ("video_started", 2_000, 0.0),
        ("info_opened", 10_000, 8.0),
        ("video_paused", 32_000, 30.0),
        ("video_seeked", 33_000, 10.0),
        ("video_resumed", 34_000, 10.0),
        ("video_completed", 64_000, 40.0),
        ("case_screen_exited", 90_000, 40.0),
    ]:
        db.add(
            InteractionLog(
                participant_id=seed_participant.id,
                event_type=event_type,
                video_id=first.id,
                payload={"currentTime": current},
                client_ts=T0 + offset,
            )
        )

    db.add(
        Note(
            participant_id=seed_participant.id,
            video_id=first.id,
            video_time_seconds=12.5,
            text="Teacher waits too long before calling on anyone.",
            client_ts=T0 + 12_500,
        )
    )
    db.add(
        TextEntry(
            participant_id=seed_participant.id,
            video_id=first.id,
            kind="diagnosis",
            text="Classroom management is the issue here.",
            time_spent_seconds=95,
        )
    )
    db.add(
        QuestionnaireResponse(
            questionnaire_id=battery.id,
            participant_id=seed_participant.id,
            video_id=first.id,
            answers={"q1": 4},
            time_spent_seconds=20,
        )
    )
    db.add(
        GazeRecording(
            participant_id=seed_participant.id,
            video_id=first.id,
            sample_count=9000,
            sampling_rate_hz=120,
        )
    )
    db.add(
        ScreenRecording(
            participant_id=seed_participant.id,
            video_id=first.id,
            status="stored",
            duration_ms=90_000,
            byte_size=5_000_000,
            epoch_ms=T0,
        )
    )
    db.add(
        ScreenRecording(
            participant_id=seed_participant.id,
            video_id=videos[1].id,
            status="failed",
            error="capture device busy",
        )
    )
    db.add(GazeCalibration(participant_id=seed_participant.id, status="success", mean_offset=0.012))
    await db.flush()
    return {"study": seed_study, "participant": seed_participant, "videos": videos}


async def test_the_overview_totals_every_study_at_once(client, run, admin_headers):
    r = await client.get("/admin/stats/overview", headers=admin_headers)

    assert r.status_code == 200
    body = r.json()
    assert body["totals"]["studies"] == 1
    assert body["totals"]["participants"] == 1
    assert body["totals"]["active"] == 1
    assert body["totals"]["notes"] == 1
    assert body["totals"]["gaze_samples"] == 9000
    assert body["totals"]["screens_stored"] == 1
    assert body["totals"]["screens_failed"] == 1

    row = body["studies"][0]
    assert row["name"] == "Test Study"
    assert row["videos"] == 2
    assert row["videos_with_file"] == 2
    assert row["last_activity_at"] is not None


async def test_a_study_nobody_is_enrolled_in_still_reports_its_cases(
    client, db, seed_study, admin_headers
):
    db.add(Video(study_id=seed_study.id, title="Unwatched", phase_type=PhaseType.training))
    await db.flush()

    r = await client.get(f"/admin/studies/{seed_study.id}/stats", headers=admin_headers)

    assert r.status_code == 200
    body = r.json()
    assert body["participants"]["total"] == 0
    assert body["participants"]["completion_rate"] is None
    assert [c["title"] for c in body["cases"]] == ["Unwatched"]


async def test_study_stats_carry_the_behaviour_recorded_against_each_case(
    client, run, admin_headers
):
    r = await client.get(f"/admin/studies/{run['study'].id}/stats", headers=admin_headers)

    assert r.status_code == 200
    body = r.json()
    assert body["participants"]["total"] == 1
    assert body["participants"]["active"] == 1
    assert body["participants"]["with_gaze"] == 1

    watched, untouched = body["cases"]
    assert watched["viewers"] == 1
    # 30s before the pause plus 30s after the resume.
    assert watched["avg_watch_seconds"] == 60.0
    assert watched["avg_on_screen_seconds"] == 90.0
    assert watched["pauses"] == 1
    assert watched["seeks"] == 1
    assert watched["plays"] == 2
    assert watched["completions"] == 1
    assert watched["info_opens"] == 1
    assert watched["notes"] == 1
    assert watched["diagnoses"] == 1
    assert watched["gaze_samples"] == 9000
    assert watched["screens_stored"] == 1
    assert untouched["viewers"] == 0
    assert untouched["screens_failed"] == 1

    assert body["calibration"]["by_status"]["success"]["attempts"] == 1
    assert body["questionnaires"][0]["responses"] == 1
    # One battery per case, so two people-cases were expected of one participant.
    assert body["questionnaires"][0]["expected"] == 2


async def test_the_roster_says_how_far_each_participant_has_got(client, run, admin_headers):
    r = await client.get(f"/admin/studies/{run['study'].id}/stats", headers=admin_headers)

    row = r.json()["roster"][0]
    assert row["id"] == run["participant"].id
    assert row["step"] == 6
    assert row["total_steps"] > row["step"]
    assert 0 < row["progress"] < 100
    assert row["cases"] == 2
    assert row["assigned_sequence"] is True
    assert row["notes"] == 1
    assert row["watch_seconds"] == 60.0


async def test_participant_stats_break_the_run_down_case_by_case(client, run, admin_headers):
    r = await client.get(
        f"/admin/participants/{run['participant'].id}/stats", headers=admin_headers
    )

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "active"
    assert body["session"]["step"] == 6
    assert body["session"]["current_step"]
    assert body["totals"]["cases"] == 2
    assert body["totals"]["cases_entered"] == 1
    assert body["totals"]["cases_completed"] == 1

    first, second = body["cases"]
    assert first["watch_seconds"] == 60.0
    # 30s of clip, then a rewind to 10s and 30s more: 60s watched, but only
    # ever 40s deep into a 120s clip.
    assert first["max_playhead_seconds"] == 40.0
    assert first["coverage"] == 33.3
    assert first["completed"] is True
    assert first["pauses"] == 1
    assert first["notes"]["snapshots"] == 1
    assert first["diagnosis"]["words"] == 6
    assert first["diagnosis"]["seconds"] == 95
    assert first["outro_answered"] is True
    assert first["gaze"]["samples"] == 9000
    assert first["screen"]["status"] == "stored"
    assert second["entered"] is False
    assert second["diagnosis"] is None
    assert second["screen"]["status"] == "failed"

    assert body["calibrations"][0]["mean_offset"] == 0.012
    assert body["questionnaires"][0]["placement"] == "case_outro"


async def test_participant_stats_for_someone_who_is_not_there(client, admin_headers):
    r = await client.get("/admin/participants/nobody/stats", headers=admin_headers)

    assert r.status_code == 404


async def test_stats_are_admin_only(client, run, participant_headers):
    for path in (
        "/admin/stats/overview",
        f"/admin/studies/{run['study'].id}/stats",
        f"/admin/participants/{run['participant'].id}/stats",
    ):
        assert (await client.get(path, headers=participant_headers)).status_code == 401


async def test_the_activity_timeline_only_covers_the_window_asked_for(
    client, db, run, admin_headers
):
    old = InteractionLog(
        participant_id=run["participant"].id,
        event_type="login",
        payload={},
        created_at=datetime.now(UTC) - timedelta(days=90),
    )
    db.add(old)
    await db.flush()

    r = await client.get("/admin/stats/overview?days=7", headers=admin_headers)

    days = {row["date"] for row in r.json()["activity"]}
    assert (datetime.now(UTC) - timedelta(days=90)).date().isoformat() not in days
