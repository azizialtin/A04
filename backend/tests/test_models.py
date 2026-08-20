import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.enums import PhaseType, QuestionnairePlacement
from app.models.note import Note
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.text_entry import TextEntry
from app.models.video import Video


async def _video(db, study, phase=PhaseType.training, **kw):
    v = Video(study_id=study.id, title=kw.pop("title", "Case"), phase_type=phase, **kw)
    db.add(v)
    await db.flush()
    return v


async def test_case_chain_persists(db, seed_study, seed_participant):
    v = await _video(
        db, seed_study, task_description="Diagnose", info_text="i", student_task_text="s"
    )
    db.add(
        ParticipantVideo(
            participant_id=seed_participant.id,
            video_id=v.id,
            slot_index=0,
            phase_type=PhaseType.training,
        )
    )
    db.add(
        Note(
            participant_id=seed_participant.id,
            video_id=v.id,
            video_time_seconds=12.5,
            text="that loop looks off",
        )
    )
    db.add(
        TextEntry(
            participant_id=seed_participant.id,
            video_id=v.id,
            text="off-by-one in the bound",
            time_spent_seconds=42,
        )
    )
    q = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Outro",
        questions=[{"id": "q1", "type": "likert", "text": "confidence?"}],
    )
    db.add(q)
    await db.flush()
    db.add(
        QuestionnaireResponse(
            questionnaire_id=q.id,
            participant_id=seed_participant.id,
            video_id=v.id,
            answers={"q1": 4},
        )
    )
    await db.flush()

    stored_video = await db.scalar(select(Video).where(Video.id == v.id))
    assert stored_video.phase_type == PhaseType.training
    note = await db.scalar(select(Note).where(Note.participant_id == seed_participant.id))
    assert note.video_time_seconds == 12.5
    resp = await db.scalar(
        select(QuestionnaireResponse).where(QuestionnaireResponse.questionnaire_id == q.id)
    )
    assert resp.answers == {"q1": 4}


async def test_participant_video_slot_is_unique(db, seed_study, seed_participant):
    v = await _video(db, seed_study)
    db.add(
        ParticipantVideo(
            participant_id=seed_participant.id,
            video_id=v.id,
            slot_index=0,
            phase_type=PhaseType.pre_test,
        )
    )
    await db.flush()
    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            db.add(
                ParticipantVideo(
                    participant_id=seed_participant.id,
                    video_id=v.id,
                    slot_index=0,
                    phase_type=PhaseType.training,
                )
            )
            await db.flush()


async def test_one_questionnaire_response_per_case(db, seed_study, seed_participant):
    v = await _video(db, seed_study)
    q = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Outro",
        questions=[],
    )
    db.add(q)
    await db.flush()
    db.add(
        QuestionnaireResponse(
            questionnaire_id=q.id,
            participant_id=seed_participant.id,
            video_id=v.id,
            answers={},
        )
    )
    await db.flush()
    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            db.add(
                QuestionnaireResponse(
                    questionnaire_id=q.id,
                    participant_id=seed_participant.id,
                    video_id=v.id,
                    answers={},
                )
            )
            await db.flush()


async def test_one_pre_test_response_per_run(db, seed_study, seed_participant):
    """A pre-test page has no case, so the per-case constraint cannot hold it:
    Postgres counts every NULL as distinct and would take the row twice."""
    q = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="Angaben zur Person",
        questions=[],
    )
    db.add(q)
    await db.flush()
    db.add(
        QuestionnaireResponse(
            questionnaire_id=q.id, participant_id=seed_participant.id, video_id=None, answers={}
        )
    )
    await db.flush()
    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            db.add(
                QuestionnaireResponse(
                    questionnaire_id=q.id,
                    participant_id=seed_participant.id,
                    video_id=None,
                    answers={},
                )
            )
            await db.flush()


async def test_a_study_has_at_most_one_outro_battery(db, seed_study):
    db.add(
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.case_outro,
            title="Nach dem Fall",
            questions=[],
        )
    )
    await db.flush()
    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            db.add(
                Questionnaire(
                    study_id=seed_study.id,
                    placement=QuestionnairePlacement.case_outro,
                    title="Und noch einmal",
                    questions=[],
                )
            )
            await db.flush()


async def test_pre_test_pages_may_be_many(db, seed_study):
    db.add_all(
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"Seite {i}",
            order_index=i,
            questions=[],
        )
        for i in range(3)
    )
    await db.flush()
