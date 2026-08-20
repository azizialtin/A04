"""One participant, nine cases, start to finish.

The unit tests check each step in isolation; this walks the whole script the way
a real sitting does — because the study gets one unrepeatable attempt per
person, and the failure mode that matters is the run not reaching the end.
"""

import pytest_asyncio
from sqlalchemy import func, select

from app.models.enums import ParticipantStatus, PhaseType, QuestionnairePlacement
from app.models.gaze_calibration import GazeCalibration
from app.models.note import Note
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.models.text_entry import TextEntry
from app.models.video import Video

# One pre-test, seven training, one post-test — the study as designed.
PHASES = [PhaseType.pre_test] + [PhaseType.training] * 7 + [PhaseType.post_test]


@pytest_asyncio.fixture
async def nine_case_study(db, seed_study):
    seed_study.sosci_pretest_url = "https://sosci.example/pre"
    seed_study.sosci_posttest_url = "https://sosci.example/post"

    videos = []
    for i, phase in enumerate(PHASES):
        v = Video(
            study_id=seed_study.id,
            title=f"Case {i + 1}",
            phase_type=phase,
            gcp_filename=f"case{i + 1}.mp4",
            task_description="Was ist das Problem?",
            time_limit_seconds=600,
        )
        db.add(v)
        videos.append(v)

    db.add(
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title="Angaben zur Person",
            order_index=0,
            questions=[{"id": "age", "type": "number", "text": "Alter"}],
        )
    )
    db.add(
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.diagnosis,
            title="Sicherheit der Diagnose",
            questions=[{"id": "confidence", "type": "slider", "text": "Wie sicher?"}],
        )
    )
    db.add(
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.case_outro,
            title="Nach dem Fall",
            questions=[{"id": "td_demand", "type": "slider", "text": "Wie viel Anstrengung?"}],
        )
    )
    await db.flush()

    participant = Participant(id="RUN-001", study_id=seed_study.id)
    db.add(participant)
    await db.flush()
    db.add_all(
        ParticipantVideo(
            participant_id=participant.id, video_id=v.id, slot_index=i, phase_type=v.phase_type
        )
        for i, v in enumerate(videos)
    )
    await db.flush()
    return {"participant": participant, "videos": videos}


async def test_a_participant_can_complete_the_whole_study(client, db, nine_case_study):
    participant = nine_case_study["participant"]

    # --- log in ------------------------------------------------------------
    login = await client.post("/auth/participant/login", json={"participant_id": "run-001"})
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (
        await db.scalar(select(Session).where(Session.participant_id == participant.id))
    ) is not None

    script = (await client.get("/participant/session", headers=headers)).json()
    steps = script["steps"]
    kinds = [s["kind"] for s in steps]

    # The shape the study design calls for.
    assert kinds.count("case_intro") == 9
    assert kinds.count("case_video") == 9
    assert kinds.count("diagnosis") == 9
    assert kinds.count("case_outro") == 9
    assert kinds.count("think_aloud") == 9
    assert kinds.count("questionnaire") == 1  # the one pre-test page
    assert kinds.count("phase_transition") == 3
    assert kinds.count("calibration") == 1
    assert kinds[0] == "welcome"
    assert kinds[-1] == "thanks"

    # --- walk it -----------------------------------------------------------
    notes_written = 0
    for index, step in enumerate(steps):
        kind = step["kind"]

        if kind == "calibration":
            r = await client.post(
                "/gaze/calibration",
                json={"status": "success", "mean_offset": 0.011, "mean_offset_degrees": 0.55},
                headers=headers,
            )
            assert r.status_code == 201

        elif kind == "case_video":
            video_id = step["video_id"]
            url = await client.get(f"/participant/videos/{video_id}/url", headers=headers)
            assert url.status_code == 200

            rec = await client.post(
                "/gaze/recordings",
                json={"video_id": video_id, "sampling_rate_hz": 120},
                headers=headers,
            )
            assert rec.status_code == 201
            await client.patch(
                f"/gaze/recordings/{rec.json()['recording_id']}/complete",
                json={"sample_count": 0},
                headers=headers,
            )

            note = await client.post(
                "/participant/notes",
                json={
                    "video_id": video_id,
                    "video_time_seconds": 12.5,
                    "text": f"Notiz zu Fall {video_id}",
                },
                headers=headers,
            )
            assert note.status_code == 201
            notes_written += 1

        elif kind == "diagnosis":
            r = await client.post(
                "/participant/diagnosis",
                json={
                    "video_id": step["video_id"],
                    "text": f"Die Schleife läuft einmal zu oft (Fall {step['video_id']})",
                    "time_spent_seconds": 87,
                    "answers": {"confidence": 4},
                },
                headers=headers,
            )
            assert r.status_code == 201

        elif kind in ("questionnaire", "case_outro"):
            answer = {"age": 34} if kind == "questionnaire" else {"td_demand": 6}
            r = await client.post(
                f"/participant/questionnaires/{step['questionnaire_id']}/respond",
                json={
                    "video_id": step["video_id"],
                    "answers": answer,
                    "time_spent_seconds": 15,
                },
                headers=headers,
            )
            assert r.status_code == 201

        elif kind == "think_aloud":
            r = await client.get(f"/gaze/videos/{step['video_id']}/replay", headers=headers)
            assert r.status_code == 200

        progress = await client.patch(
            "/participant/session/progress",
            json={"current_step_index": index + 1},
            headers=headers,
        )
        assert progress.status_code == 200, f"stuck at step {index} ({kind})"

    # --- and it is finished ------------------------------------------------
    assert progress.json()["complete"] is True
    await db.refresh(participant)
    assert participant.status == ParticipantStatus.completed

    session = await db.scalar(select(Session).where(Session.participant_id == participant.id))
    assert session.completed_at is not None

    async def count(model):
        return await db.scalar(
            select(func.count()).select_from(model).where(model.participant_id == participant.id)
        )

    assert notes_written == 9
    assert await count(Note) == 9
    assert await count(TextEntry) == 9  # one diagnosis per case, not two
    # One pre-test page, plus an outro battery and a confidence rating per case.
    assert await count(QuestionnaireResponse) == 1 + 9 + 9
    assert await count(GazeCalibration) == 1


async def test_a_completed_participant_cannot_start_again(client, nine_case_study):
    participant = nine_case_study["participant"]
    participant.status = ParticipantStatus.completed

    r = await client.post("/auth/participant/login", json={"participant_id": participant.id})

    assert r.status_code == 403


async def test_a_run_resumes_where_it_was_left(client, nine_case_study):
    headers = {
        "Authorization": "Bearer "
        + (await client.post("/auth/participant/login", json={"participant_id": "RUN-001"})).json()[
            "access_token"
        ]
    }

    await client.patch(
        "/participant/session/progress", json={"current_step_index": 14}, headers=headers
    )

    # As if the browser had been closed and reopened.
    resumed = (await client.get("/participant/session", headers=headers)).json()
    assert resumed["current_step_index"] == 14
    assert resumed["steps"][13]["completed"] is True
    assert resumed["steps"][14]["completed"] is False


async def test_the_run_carries_the_participant_id_to_sosci(client, nine_case_study):
    headers = {
        "Authorization": "Bearer "
        + (await client.post("/auth/participant/login", json={"participant_id": "RUN-001"})).json()[
            "access_token"
        ]
    }
    steps = (await client.get("/participant/session", headers=headers)).json()["steps"]

    sosci = [s for s in steps if s["kind"] == "sosci"]
    assert [s["variant"] for s in sosci] == ["pretest", "posttest"]
    # The two data sources are joined on this later; if it is wrong the survey
    # answers cannot be matched to the run at all.
    assert all(s["participant_id"] == "RUN-001" for s in sosci)
    assert sosci[0]["url"] == "https://sosci.example/pre"
