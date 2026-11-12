"""The statistics the admin dashboard reads a study by.

Most of it is counting, and counting is only interesting where it can be wrong:
the spans reconstructed from the event log, the denominators a completion rate
is a fraction of, and the arithmetic step count that stands in for building
every participant's script.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.screen_recording import ScreenRecording
from app.models.session import Session
from app.models.text_entry import TextEntry
from app.models.video import Video
from app.services.session_script import build_steps, count_steps
from app.services.stats import median, rate, recording_coverage, summarise_case

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


@pytest.mark.parametrize("completion_signal", ["status", "timestamp", "both"])
async def test_completed_progress_is_full_in_participant_and_study_stats(
    client, db, run, admin_headers, completion_signal
):
    p = run["participant"]
    session = await db.scalar(select(Session).where(Session.participant_id == p.id))
    steps = await build_steps(db, p)
    session.current_step_index = len(steps) - 1
    if completion_signal in ("status", "both"):
        p.status = ParticipantStatus.completed
    if completion_signal in ("timestamp", "both"):
        session.completed_at = datetime.now(UTC)
    await db.flush()

    participant = (
        await client.get(f"/admin/participants/{p.id}/stats", headers=admin_headers)
    ).json()
    study = (await client.get(f"/admin/studies/{p.study_id}/stats", headers=admin_headers)).json()
    assert participant["session"]["progress"] == 100
    assert study["roster"][0]["progress"] == 100
    assert study["participants"]["avg_progress"] == 100


async def test_case_gaze_uses_capture_intervals_and_keeps_other_screens_in_totals(
    client, db, run, admin_headers
):
    p = run["participant"]
    first = await db.scalar(select(GazeRecording).where(GazeRecording.participant_id == p.id))
    start = datetime(2026, 1, 1, tzinfo=UTC)
    first.started_at = start
    first.completed_at = start + timedelta(seconds=100)
    # 9,000 / 12,000 plus a resumed attempt at a different frequency: 10,800 / 14,400.
    db.add_all(
        [
            GazeRecording(
                participant_id=p.id,
                video_id=first.video_id,
                step_kind="case_video",
                sample_count=1800,
                sampling_rate_hz=60,
                started_at=start + timedelta(hours=1),
                completed_at=start + timedelta(hours=1, seconds=40),
            ),
            GazeRecording(
                participant_id=p.id,
                video_id=first.video_id,
                step_kind="diagnosis",
                sample_count=90000,
                sampling_rate_hz=120,
            ),
            GazeRecording(
                participant_id=p.id,
                video_id=None,
                step_kind="questionnaire",
                sample_count=500,
                sampling_rate_hz=120,
            ),
        ]
    )
    await db.flush()
    participant = (
        await client.get(f"/admin/participants/{p.id}/stats", headers=admin_headers)
    ).json()
    study = (await client.get(f"/admin/studies/{p.study_id}/stats", headers=admin_headers)).json()
    case = participant["cases"][0]["gaze"]
    assert case["samples"] == 10800
    assert case["recordings"] == 2
    assert case["expected_samples"] == 14400
    assert case["yield"] == 75
    assert case["sampling_rate_hz"] is None
    assert participant["totals"]["gaze_samples"] == 101300
    assert study["cases"][0]["gaze_samples"] == 10800
    assert study["roster"][0]["gaze_samples"] == 101300


@pytest.mark.parametrize(
    "seconds,hz,samples", [(None, 120, 10), (0, 120, 10), (-1, 120, 10), (10, 0, 10), (1, 120, 121)]
)
def test_gaze_coverage_is_unknown_for_unfinished_or_inconsistent_captures(seconds, hz, samples):
    start = datetime(2026, 1, 1, tzinfo=UTC)
    bad = SimpleNamespace(
        started_at=start,
        completed_at=None if seconds is None else start + timedelta(seconds=seconds),
        sampling_rate_hz=hz,
        sample_count=samples,
    )
    good = SimpleNamespace(
        started_at=start,
        completed_at=start + timedelta(seconds=100),
        sampling_rate_hz=120,
        sample_count=100,
    )
    result = recording_coverage([bad, good])
    assert result["yield"] is None
    assert result["expected_samples"] is None
    assert result["samples"] == samples + 100


def test_empty_and_zero_sample_gaze_coverage_are_different():
    assert recording_coverage([])["yield"] is None
    start = datetime(2026, 1, 1, tzinfo=UTC)
    empty = SimpleNamespace(
        started_at=start,
        completed_at=start + timedelta(seconds=10),
        sampling_rate_hz=120,
        sample_count=0,
    )
    assert recording_coverage([empty])["yield"] == 0


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


@pytest_asyncio.fixture
async def pre_tests(db, seed_study, seed_participant):
    """Three pre-test pages in two sections, answered by two people with known
    times — the figures the researchers asked to see added up."""
    pages = [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title="Angaben zur Person",
            section="Demographics",
            order_index=0,
            questions=[{"id": "age", "type": "number", "text": "Alter"}],
        ),
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title="Fachwissen Programmierung",
            section="CK-Pretest",
            order_index=1,
            questions=[{"id": "ck_pre_loop", "type": "number", "text": "Schleifen"}],
        ),
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title="Fachwissen Debugging",
            section="CK-Pretest",
            order_index=2,
            questions=[{"id": "ck_pre_debug", "type": "number", "text": "Debugging"}],
        ),
    ]
    db.add_all(pages)
    other = Participant(id="T-002", study_id=seed_study.id)
    db.add(other)
    await db.flush()

    # T-001: 100 s + 60 s + 40 s; T-002: 200 s on demographics only.
    for pid, page, seconds in [
        ("T-001", pages[0], 100),
        ("T-001", pages[1], 60),
        ("T-001", pages[2], 40),
        ("T-002", pages[0], 200),
    ]:
        db.add(
            QuestionnaireResponse(
                questionnaire_id=page.id,
                participant_id=pid,
                video_id=None,
                answers={"x": 1},
                time_spent_seconds=seconds,
            )
        )
    await db.flush()
    return pages


async def test_study_stats_add_up_the_time_per_section_over_people(
    client, seed_study, pre_tests, admin_headers
):
    r = await client.get(f"/admin/studies/{seed_study.id}/stats", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()

    assert [q["section"] for q in body["questionnaires"]] == [
        "Demographics",
        "CK-Pretest",
        "CK-Pretest",
    ]
    # Pre-test sections first, in page order.
    assert [s["section"] for s in body["sections"]] == ["Demographics", "CK-Pretest"]
    by_name = {s["section"]: s for s in body["sections"]}
    # Demographics: 100 s and 200 s, one page each.
    assert by_name["Demographics"]["pages"] == 1
    assert by_name["Demographics"]["participants"] == 2
    assert by_name["Demographics"]["avg_seconds"] == 150
    assert by_name["Demographics"]["median_seconds"] == 150
    # CK-Pretest: two pages, only T-001 answered them, 60 + 40.
    assert by_name["CK-Pretest"]["pages"] == 2
    assert by_name["CK-Pretest"]["participants"] == 1
    assert by_name["CK-Pretest"]["avg_seconds"] == 100
    assert by_name["CK-Pretest"]["pre_test"] is True


async def test_participant_stats_total_each_section_in_the_order_it_was_met(
    client, pre_tests, admin_headers
):
    r = await client.get("/admin/participants/T-001/stats", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()

    assert [q["section"] for q in body["questionnaires"]] == [
        "Demographics",
        "CK-Pretest",
        "CK-Pretest",
    ]
    assert body["sections"] == [
        {"section": "Demographics", "pages": 1, "seconds": 100, "pre_test": True},
        {"section": "CK-Pretest", "pages": 2, "seconds": 100, "pre_test": True},
    ]
    assert body["timed_sections"] == []
    assert all(q["response_status"] == "submitted" for q in body["questionnaires"])


async def test_timed_statistics_keep_original_attempt_and_visit_snapshots(
    client, db, seed_study, seed_participant, admin_headers
):
    pages = [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"CK {i}",
            section="CK-Aufgaben",
            section_key="ck_tasks",
            order_index=i,
            questions=[{"id": f"ck_{i}", "type": "free_text", "text": "Fehler?"}],
        )
        for i in range(4)
    ]
    db.add_all(pages)
    db.add(Participant(id="OTHER", study_id=seed_study.id))
    await db.flush()
    db.add(
        SectionAttempt(
            participant_id=seed_participant.id,
            section="CK-Aufgaben",
            section_key="ck_tasks",
            started_client_ts=T0,
            ended_client_ts=T0 + 425_000,
            # The server and client clocks may differ: overrun uses the client duration.
            deadline_ms=T0 + 3_600_000 + 420_000,
            exit_reason="supervisor_finish",
        )
    )
    for visit_id, page, start, end, reason, review, answers in [
        ("first", pages[0], 0, 200_000, "submitted", False, {"ck_0": "Original"}),
        ("lost-exit", pages[1], 200_000, None, None, False, None),
        ("partial", pages[1], 210_000, 425_000, "supervisor_finish", False, {"ck_1": "Teil"}),
        ("review", pages[0], 900_000, 905_000, "submitted", True, {"ck_0": "Korrigiert"}),
        ("review-only", pages[2], 950_000, 960_000, "submitted", True, {"ck_2": "Später"}),
    ]:
        db.add(
            QuestionnaireVisit(
                id=visit_id,
                participant_id=seed_participant.id,
                questionnaire_id=page.id,
                section_key="ck_tasks",
                step_index=page.order_index + 1,
                entered_client_ts=T0 + start,
                exited_client_ts=T0 + end if end is not None else None,
                exit_reason=reason,
                is_review=review,
                submitted_answers=answers,
            )
        )
    db.add(
        QuestionnaireVisit(
            id="other-person",
            participant_id="OTHER",
            questionnaire_id=pages[0].id,
            section_key="ck_tasks",
            step_index=1,
            entered_client_ts=T0,
        )
    )
    for page, answer, seconds, response_status in [
        (pages[0], {"ck_0": "Korrigiert"}, 5, "submitted"),
        (pages[1], {"ck_1": "Teil"}, 215, "partial"),
    ]:
        db.add(
            QuestionnaireResponse(
                participant_id=seed_participant.id,
                questionnaire_id=page.id,
                answers=answer,
                time_spent_seconds=seconds,
                response_status=response_status,
            )
        )
    await db.flush()

    response = await client.get(
        f"/admin/participants/{seed_participant.id}/stats", headers=admin_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["sections"][0]["seconds"] == 220  # Latest response totals retain their meaning.
    assert [q["response_status"] for q in body["questionnaires"]] == ["submitted", "partial"]
    assert len(body["timed_sections"]) == 1
    attempt = body["timed_sections"][0]
    assert attempt["started_client_ts"] == T0
    assert attempt["ended_client_ts"] == T0 + 425_000
    assert attempt["deadline_ms"] == T0 + 4_020_000
    assert attempt["elapsed_seconds"] == 425
    assert attempt["deadline_overrun_seconds"] == 5
    assert attempt["exit_reason"] == "supervisor_finish"
    assert attempt["visited_pages"] == 2  # Review-only work does not enter the original sitting.
    visits = attempt["page_visits"]
    assert [v["visit_id"] for v in visits] == [
        "first",
        "lost-exit",
        "partial",
        "review",
        "review-only",
    ]
    assert visits[0]["title"] == "CK 0"
    assert visits[0]["submitted_answers"] == {"ck_0": "Original"}
    assert visits[1]["exited_client_ts"] is None
    assert visits[1]["elapsed_seconds"] is None
    assert visits[1]["submitted_answers"] is None
    assert visits[2]["exit_reason"] == "supervisor_finish"
    assert visits[3]["is_review"] is True
    assert visits[3]["submitted_answers"] == {"ck_0": "Korrigiert"}
    assert pages[3].id not in {v["questionnaire_id"] for v in visits}


async def test_open_timed_attempt_has_no_invented_end_or_elapsed_time(
    client, db, seed_study, seed_participant, admin_headers
):
    page = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="CK 1",
        section="CK-Aufgaben",
        section_key="ck_tasks",
        questions=[{"id": "ck_1", "type": "free_text", "text": "Fehler?"}],
    )
    db.add(page)
    await db.flush()
    db.add(
        SectionAttempt(
            participant_id=seed_participant.id,
            section="CK-Aufgaben",
            section_key="ck_tasks",
            started_client_ts=T0,
            deadline_ms=T0 + 420_000,
        )
    )
    db.add(
        QuestionnaireVisit(
            id="open",
            participant_id=seed_participant.id,
            questionnaire_id=page.id,
            section_key="ck_tasks",
            step_index=1,
            entered_client_ts=T0,
        )
    )
    await db.flush()

    response = await client.get(
        f"/admin/participants/{seed_participant.id}/stats", headers=admin_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["questionnaires"] == []
    assert body["sections"] == []
    attempt = body["timed_sections"][0]
    assert attempt["ended_client_ts"] is None
    assert attempt["elapsed_seconds"] is None
    assert attempt["deadline_overrun_seconds"] is None
    assert attempt["exit_reason"] is None
    assert attempt["visited_pages"] == 1
    assert attempt["page_visits"][0]["exited_client_ts"] is None
    assert attempt["page_visits"][0]["elapsed_seconds"] is None


async def test_a_page_without_a_section_is_a_section_of_its_own(client, run, admin_headers):
    # The `run` fixture's outro battery has no section: it must still appear,
    # under its own title, rather than vanish from the totals.
    r = await client.get(f"/admin/studies/{run['study'].id}/stats", headers=admin_headers)
    sections = r.json()["sections"]
    assert [s["section"] for s in sections] == ["Outro"]
    assert sections[0]["pre_test"] is False
    assert sections[0]["avg_seconds"] == 20
