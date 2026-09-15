import pytest_asyncio
from sqlalchemy import func, select

from app.core.config import get_settings
from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.note import Note
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.models.study import Study
from app.models.text_entry import TextEntry
from app.models.video import Video


@pytest_asyncio.fixture
async def run(db, seed_study, seed_participant):
    """Three assigned cases (pre / training / post), a one-page pre-test, a
    confidence rating on the diagnosis, an outro battery, and an open session."""
    seed_study.sosci_pretest_url = "https://sosci.example/pre"
    seed_study.sosci_posttest_url = "https://sosci.example/post"

    videos = {}
    for slot, (key, phase) in enumerate(
        [("pre", PhaseType.pre_test), ("train", PhaseType.training), ("post", PhaseType.post_test)]
    ):
        v = Video(
            study_id=seed_study.id,
            title=key,
            phase_type=phase,
            gcp_filename=f"{key}.mp4",
            task_description="Diagnose",
            info_text="info",
            student_task_text="task",
            time_limit_seconds=120,
        )
        db.add(v)
        await db.flush()
        db.add(
            ParticipantVideo(
                participant_id=seed_participant.id, video_id=v.id, slot_index=slot, phase_type=phase
            )
        )
        videos[key] = v

    pre_test = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="Angaben zur Person",
        order_index=0,
        questions=[{"id": "age", "type": "number", "text": "Alter"}],
    )
    ratings = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.diagnosis,
        title="Sicherheit",
        questions=[{"id": "confidence", "type": "slider", "text": "Wie sicher?"}],
    )
    outro = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Outro",
        questions=[{"id": "d", "type": "likert", "text": "difficulty"}],
    )
    db.add_all([pre_test, ratings, outro])

    seed_participant.status = ParticipantStatus.active
    db.add(Session(participant_id=seed_participant.id))
    await db.flush()

    return {
        "participant": seed_participant,
        "videos": videos,
        "questionnaires": {"pre_test": pre_test, "ratings": ratings, "outro": outro},
    }


async def test_session_requires_auth(client):
    r = await client.get("/participant/session")
    assert r.status_code == 401


async def test_me(client, run, participant_headers):
    r = await client.get("/participant/me", headers=participant_headers)
    assert r.status_code == 200
    assert r.json()["id"] == run["participant"].id
    assert r.json()["study_name"] == "Test Study"


async def test_session_script_shape(client, run, participant_headers, monkeypatch):
    # This test pins the shape of the run *with* the in-app calibration step.
    monkeypatch.setattr(get_settings(), "CALIBRATION_ENABLED", True)
    r = await client.get("/participant/session", headers=participant_headers)
    assert r.status_code == 200
    data = r.json()
    steps = data["steps"]
    kinds = [s["kind"] for s in steps]

    # Welcome, then the pre-test pages, then the survey hand-off.
    assert kinds[0] == "welcome"
    assert steps[1]["kind"] == "questionnaire" and steps[1]["placement"] == "pre_test"
    assert steps[1]["video_id"] is None
    assert (steps[1]["page"], steps[1]["page_count"]) == (1, 1)
    assert steps[2]["kind"] == "sosci" and steps[2]["variant"] == "pretest"
    assert steps[2]["url"] == "https://sosci.example/pre"
    assert steps[2]["participant_id"] == run["participant"].id
    assert steps[-1]["kind"] == "thanks"
    assert steps[-2]["kind"] == "sosci" and steps[-2]["variant"] == "posttest"

    # Calibrate once, after the pre-test survey and before the first case.
    assert kinds.index("calibration") == 3
    assert kinds.count("calibration") == 1
    assert kinds.index("calibration") < kinds.index("case_video")

    assert kinds.count("phase_transition") == 3
    assert kinds.count("case_intro") == 3
    assert kinds.count("case_video") == 3
    assert kinds.count("diagnosis") == 3
    assert kinds.count("case_outro") == 3
    assert kinds.count("think_aloud") == 3
    # Only the pre-test page is a questionnaire step of its own; the diagnosis
    # and outro questions live inside their screens.
    assert kinds.count("questionnaire") == 1
    assert data["current_step_index"] == 0
    assert data["total_steps"] == len(steps)


async def test_calibration_step_can_be_disabled(client, run, participant_headers, monkeypatch):
    # With external calibration the step is gone, but the cases are untouched.
    monkeypatch.setattr(get_settings(), "CALIBRATION_ENABLED", False)
    data = (await client.get("/participant/session", headers=participant_headers)).json()
    kinds = [s["kind"] for s in data["steps"]]
    assert "calibration" not in kinds
    assert kinds.count("case_video") == 3
    assert data["total_steps"] == len(data["steps"])


async def test_the_case_screens_carry_their_questions(client, run, participant_headers):
    steps = (await client.get("/participant/session", headers=participant_headers)).json()["steps"]

    diagnosis = next(s for s in steps if s["kind"] == "diagnosis")
    assert [q["id"] for q in diagnosis["questions"]] == ["confidence"]

    outro = next(s for s in steps if s["kind"] == "case_outro")
    assert outro["questionnaire_id"] == run["questionnaires"]["outro"].id
    assert [q["id"] for q in outro["questions"]] == ["d"]


async def test_an_unwritten_page_is_not_shown(client, db, run, participant_headers):
    """The PCK block is seeded empty until its items exist; a page with no
    questions would be a heading over nothing."""
    db.add(
        Questionnaire(
            study_id=run["participant"].study_id,
            placement=QuestionnairePlacement.pre_test,
            title="Fachdidaktisches Wissen",
            order_index=1,
            questions=[],
        )
    )
    await db.flush()

    steps = (await client.get("/participant/session", headers=participant_headers)).json()["steps"]
    assert [s["kind"] for s in steps].count("questionnaire") == 1


async def test_progress_is_forward_only(client, run, participant_headers):
    await client.patch(
        "/participant/session/progress", json={"current_step_index": 5}, headers=participant_headers
    )
    await client.patch(
        "/participant/session/progress", json={"current_step_index": 3}, headers=participant_headers
    )
    r = await client.get("/participant/session", headers=participant_headers)
    assert r.json()["current_step_index"] == 5


async def test_progress_completes_at_thanks(client, db, run, participant_headers):
    total = (await client.get("/participant/session", headers=participant_headers)).json()[
        "total_steps"
    ]
    r = await client.patch(
        "/participant/session/progress",
        json={"current_step_index": total - 1},
        headers=participant_headers,
    )
    assert r.json()["complete"] is True
    await db.refresh(run["participant"])
    assert run["participant"].status == ParticipantStatus.completed


async def test_video_url_local(client, run, participant_headers):
    vid = run["videos"]["pre"].id
    r = await client.get(f"/participant/videos/{vid}/url", headers=participant_headers)
    assert r.status_code == 200
    assert r.json()["signed_url"] == "/uploads/videos/pre.mp4"


async def test_video_url_rejects_unassigned(client, db, seed_study, run, participant_headers):
    other = Video(
        study_id=seed_study.id, title="x", phase_type=PhaseType.training, gcp_filename="x.mp4"
    )
    db.add(other)
    await db.flush()
    r = await client.get(f"/participant/videos/{other.id}/url", headers=participant_headers)
    assert r.status_code == 404


async def test_create_note(client, db, run, participant_headers):
    vid = run["videos"]["train"].id
    r = await client.post(
        "/participant/notes",
        json={"video_id": vid, "video_time_seconds": 10.5, "text": "loop bound is off"},
        headers=participant_headers,
    )
    assert r.status_code == 201
    note = await db.scalar(select(Note).where(Note.video_id == vid))
    assert note.text == "loop bound is off"
    assert note.video_time_seconds == 10.5


async def test_create_diagnosis(client, db, run, participant_headers):
    vid = run["videos"]["pre"].id
    r = await client.post(
        "/participant/diagnosis",
        json={
            "video_id": vid,
            "text": "off-by-one",
            "time_spent_seconds": 30,
            "answers": {"confidence": 4},
        },
        headers=participant_headers,
    )
    assert r.status_code == 201
    entry = await db.scalar(select(TextEntry).where(TextEntry.video_id == vid))
    assert entry.kind == "diagnosis"

    # The rating is stored with the write-up, not as a separate submission.
    rating = await db.scalar(
        select(QuestionnaireResponse).where(
            QuestionnaireResponse.questionnaire_id == run["questionnaires"]["ratings"].id
        )
    )
    assert rating.answers == {"confidence": 4}
    assert rating.video_id == vid


async def test_a_diagnosis_without_its_rating_is_refused(client, run, participant_headers):
    r = await client.post(
        "/participant/diagnosis",
        json={"video_id": run["videos"]["pre"].id, "text": "off-by-one"},
        headers=participant_headers,
    )
    assert r.status_code == 422
    assert "confidence" in r.json()["detail"]["missing"]


async def test_questionnaire_respond_ok(client, db, run, participant_headers):
    q = run["questionnaires"]["outro"]
    vid = run["videos"]["pre"].id
    r = await client.post(
        f"/participant/questionnaires/{q.id}/respond",
        json={"video_id": vid, "answers": {"d": 4}},
        headers=participant_headers,
    )
    assert r.status_code == 201
    stored = await db.scalar(
        select(QuestionnaireResponse).where(QuestionnaireResponse.questionnaire_id == q.id)
    )
    assert stored.answers == {"d": 4}


async def test_a_pre_test_page_is_answered_without_a_case(client, db, run, participant_headers):
    q = run["questionnaires"]["pre_test"]
    r = await client.post(
        f"/participant/questionnaires/{q.id}/respond",
        json={"answers": {"age": 34}, "time_spent_seconds": 40},
        headers=participant_headers,
    )
    assert r.status_code == 201
    stored = await db.scalar(
        select(QuestionnaireResponse).where(QuestionnaireResponse.questionnaire_id == q.id)
    )
    assert stored.video_id is None
    assert stored.answers == {"age": 34}


async def test_a_battery_cannot_be_filed_under_the_wrong_thing(client, run, participant_headers):
    vid = run["videos"]["pre"].id
    pre_test = run["questionnaires"]["pre_test"]
    outro = run["questionnaires"]["outro"]

    # A pre-test page has no case…
    with_case = await client.post(
        f"/participant/questionnaires/{pre_test.id}/respond",
        json={"video_id": vid, "answers": {"age": 34}},
        headers=participant_headers,
    )
    assert with_case.status_code == 400

    # …and a case battery cannot be answered without one.
    without_case = await client.post(
        f"/participant/questionnaires/{outro.id}/respond",
        json={"answers": {"d": 4}},
        headers=participant_headers,
    )
    assert without_case.status_code == 400


async def test_diagnosis_ratings_go_through_the_diagnosis(client, run, participant_headers):
    r = await client.post(
        f"/participant/questionnaires/{run['questionnaires']['ratings'].id}/respond",
        json={"video_id": run["videos"]["pre"].id, "answers": {"confidence": 4}},
        headers=participant_headers,
    )
    assert r.status_code == 400


async def test_questionnaire_missing_required_422(client, run, participant_headers):
    q = run["questionnaires"]["outro"]
    vid = run["videos"]["pre"].id
    r = await client.post(
        f"/participant/questionnaires/{q.id}/respond",
        json={"video_id": vid, "answers": {}},
        headers=participant_headers,
    )
    assert r.status_code == 422
    assert "d" in r.json()["detail"]["missing"]


async def test_questionnaire_duplicate_is_noop(client, db, run, participant_headers):
    q = run["questionnaires"]["outro"]
    vid = run["videos"]["pre"].id
    await client.post(
        f"/participant/questionnaires/{q.id}/respond",
        json={"video_id": vid, "answers": {"d": 4}},
        headers=participant_headers,
    )
    r2 = await client.post(
        f"/participant/questionnaires/{q.id}/respond",
        json={"video_id": vid, "answers": {"d": 5}},
        headers=participant_headers,
    )
    assert r2.status_code in (200, 201)
    count = await db.scalar(
        select(func.count())
        .select_from(QuestionnaireResponse)
        .where(QuestionnaireResponse.questionnaire_id == q.id)
    )
    assert count == 1


async def test_resubmitting_a_diagnosis_replaces_it(client, db, run, participant_headers):
    vid = run["videos"]["pre"].id
    first = await client.post(
        "/participant/diagnosis",
        json={
            "video_id": vid,
            "text": "first attempt",
            "time_spent_seconds": 30,
            "answers": {"confidence": 2},
        },
        headers=participant_headers,
    )
    second = await client.post(
        "/participant/diagnosis",
        json={
            "video_id": vid,
            "text": "what they actually meant",
            "time_spent_seconds": 95,
            "answers": {"confidence": 5},
        },
        headers=participant_headers,
    )

    assert first.json()["id"] == second.json()["id"]

    entries = (
        (
            await db.execute(
                select(TextEntry).where(TextEntry.participant_id == run["participant"].id)
            )
        )
        .scalars()
        .all()
    )
    assert len(entries) == 1
    assert entries[0].text == "what they actually meant"
    assert entries[0].time_spent_seconds == 95


async def test_a_diagnosis_is_per_case(client, db, run, participant_headers):
    for key in ("pre", "train"):
        await client.post(
            "/participant/diagnosis",
            json={
                "video_id": run["videos"][key].id,
                "text": f"about {key}",
                "answers": {"confidence": 3},
            },
            headers=participant_headers,
        )

    count = await db.scalar(
        select(func.count()).select_from(TextEntry).where(TextEntry.kind == "diagnosis")
    )
    assert count == 2


async def test_events_accepted(client, run, participant_headers):
    vid = run["videos"]["pre"].id
    r = await client.post(
        "/participant/events",
        json={"event_type": "video_started", "video_id": vid, "payload": {"currentTime": 0}},
        headers=participant_headers,
    )
    assert r.status_code == 202


async def test_event_keeps_the_browsers_timestamp(client, run, participant_headers, monkeypatch):
    # The gaze replay lines playback events up against bridge samples, so the
    # browser's clock has to survive the trip rather than being replaced by the
    # database's.
    logged: list[dict] = []

    async def _record(**kwargs):
        logged.append(kwargs)

    monkeypatch.setattr("app.api.participant.log_event", _record)

    r = await client.post(
        "/participant/events",
        json={
            "event_type": "video_started",
            "video_id": run["videos"]["pre"].id,
            "payload": {"currentTime": 0},
            "client_ts": 1_755_000_000_123,
        },
        headers=participant_headers,
    )
    assert r.status_code == 202
    assert logged[0]["client_ts"] == 1_755_000_000_123


async def test_case_video_step_carries_content(client, run, participant_headers):
    data = (await client.get("/participant/session", headers=participant_headers)).json()
    case_video = next(s for s in data["steps"] if s["kind"] == "case_video")
    assert case_video["task_description"] == "Diagnose"
    assert case_video["info_text"] == "info"
    assert case_video["student_task_text"] == "task"
    assert case_video["time_limit_seconds"] == 120
    assert case_video["title"]


async def test_unassigned_participant_falls_back_to_study_videos(
    client, db, seed_study, seed_participant, participant_headers
):
    # Study has videos, but the participant has NO assigned sequence.
    pre = Video(
        study_id=seed_study.id, title="pre", phase_type=PhaseType.pre_test, gcp_filename="p.mp4"
    )
    train = Video(
        study_id=seed_study.id, title="train", phase_type=PhaseType.training, gcp_filename="t.mp4"
    )
    db.add(pre)
    db.add(train)
    await db.flush()
    seed_participant.status = ParticipantStatus.active
    db.add(Session(participant_id=seed_participant.id))
    await db.flush()

    data = (await client.get("/participant/session", headers=participant_headers)).json()
    kinds = [s["kind"] for s in data["steps"]]
    assert kinds.count("case_video") == 2
    # Fallback orders by phase: the pre-test video comes first.
    first_case = next(s for s in data["steps"] if s["kind"] == "case_video")
    assert first_case["video_id"] == pre.id


async def test_fallback_run_authorises_the_per_video_endpoints(
    client, db, seed_study, seed_participant, participant_headers
):
    """A participant on the study default must be able to actually *use* the
    case: fetch the clip, answer its questions, take notes, submit a diagnosis."""
    video = Video(
        study_id=seed_study.id, title="v", phase_type=PhaseType.pre_test, gcp_filename="v.mp4"
    )
    q = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Outro",
        questions=[{"id": "c", "type": "likert", "text": "confidence"}],
    )
    db.add(video)
    db.add(q)
    await db.flush()
    seed_participant.status = ParticipantStatus.active
    db.add(Session(participant_id=seed_participant.id))
    await db.flush()

    assert (
        await client.get(f"/participant/videos/{video.id}/url", headers=participant_headers)
    ).status_code == 200
    assert (
        await client.post(
            f"/participant/questionnaires/{q.id}/respond",
            json={"video_id": video.id, "answers": {"c": 4}},
            headers=participant_headers,
        )
    ).status_code == 201
    assert (
        await client.post(
            "/participant/notes",
            json={"video_id": video.id, "video_time_seconds": 1.0, "text": "n"},
            headers=participant_headers,
        )
    ).status_code == 201
    assert (
        await client.post(
            "/participant/diagnosis",
            json={"video_id": video.id, "text": "off by one"},
            headers=participant_headers,
        )
    ).status_code == 201


async def test_fallback_run_still_rejects_another_studys_video(
    client, db, seed_participant, participant_headers
):
    other = Study(name="Someone else's study")
    db.add(other)
    await db.flush()
    foreign = Video(
        study_id=other.id, title="x", phase_type=PhaseType.training, gcp_filename="x.mp4"
    )
    db.add(foreign)
    await db.flush()
    seed_participant.status = ParticipantStatus.active
    db.add(Session(participant_id=seed_participant.id))
    await db.flush()

    r = await client.get(f"/participant/videos/{foreign.id}/url", headers=participant_headers)
    assert r.status_code == 404


async def test_get_video_notes_in_order(client, run, participant_headers):
    vid = run["videos"]["pre"].id
    await client.post(
        "/participant/notes",
        json={"video_id": vid, "video_time_seconds": 2.0, "text": "first"},
        headers=participant_headers,
    )
    await client.post(
        "/participant/notes",
        json={"video_id": vid, "video_time_seconds": 8.0, "text": "second"},
        headers=participant_headers,
    )
    r = await client.get(f"/participant/videos/{vid}/notes", headers=participant_headers)
    assert r.status_code == 200
    notes = r.json()
    assert [n["text"] for n in notes] == ["first", "second"]
    assert notes[0]["video_time_seconds"] == 2.0


async def test_an_advance_records_the_screen_it_finished(
    client, run, participant_headers, monkeypatch
):
    """A progress row used to be three numbers, and no one could tell from it
    which questionnaire or which case a participant had just come off."""
    logged: list[dict] = []

    async def record(**kwargs):
        logged.append(kwargs)

    monkeypatch.setattr("app.api.participant.log_event", record)

    async def advance(to: int) -> dict:
        await client.patch(
            "/participant/session/progress",
            json={"current_step_index": to},
            headers=participant_headers,
        )
        return logged[-1]["payload"]

    assert (await advance(1))["completed_step"]["kind"] == "welcome"

    # Step 1 is the pre-test page — the event the researchers were reading.
    finished = await advance(2)
    assert finished["completed_step"] == {
        "index": 1,
        "kind": "questionnaire",
        "title": "Angaben zur Person",
        "placement": "pre_test",
        "questionnaire_id": run["questionnaires"]["pre_test"].id,
        "page": 1,
        "page_count": 1,
    }
    # And where they went next, so one row tells the whole move.
    assert finished["current_step"]["kind"] == "sosci"
    assert finished["complete"] is False

    # A refresh re-sending a step already behind them finished nothing.
    assert "completed_step" not in await advance(1)


async def test_a_case_advance_names_its_video(client, run, participant_headers, monkeypatch):
    logged: list[dict] = []

    async def record(**kwargs):
        logged.append(kwargs)

    monkeypatch.setattr("app.api.participant.log_event", record)

    steps = (await client.get("/participant/session", headers=participant_headers)).json()["steps"]
    clip = next(s for s in steps if s["kind"] == "case_video")

    for target in (clip["index"], clip["index"] + 1):
        await client.patch(
            "/participant/session/progress",
            json={"current_step_index": target},
            headers=participant_headers,
        )
    completed = logged[-1]["payload"]["completed_step"]
    assert completed["kind"] == "case_video"
    assert (completed["title"], completed["video_id"]) == ("pre", run["videos"]["pre"].id)
