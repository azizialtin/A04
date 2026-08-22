"""Builds a participant's linear step-script from their assigned video sequence.

The run opens with a welcome, the pre-test pages (demographics, PCK, CK) and the
SoSci hand-off, then calibrates the eye tracker once and works through the nine
cases. Each case is intro text → clip → written diagnosis → outro questions →
think-aloud, and a `phase_transition` marks where the phase changes.

If a participant has no explicit sequence, we fall back to the study's videos in
phase order (pre-test → training → post-test, then upload order) so that
uploading videos to a study "just works". A per-participant sequence, when set,
overrides that default — that's where the personalisation lives.
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.enums import PhaseType, QuestionnairePlacement
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire
from app.models.study import Study
from app.models.video import Video

_PHASE_NUMBER = {PhaseType.pre_test: 1, PhaseType.training: 2, PhaseType.post_test: 3}
_PHASE_ORDER = {PhaseType.pre_test: 0, PhaseType.training: 1, PhaseType.post_test: 2}


def default_order(videos: Sequence[Video]) -> list[Video]:
    """The study's videos as a participant with no sequence of their own meets
    them: phase order first, then upload order."""
    return sorted(videos, key=lambda v: (_PHASE_ORDER.get(v.phase_type, 9), v.id))


def count_steps(pre_test_pages: int, phases: Sequence[PhaseType], calibration: bool) -> int:
    """How many steps `build_steps` produces for a run with these ingredients.

    The admin participant list wants everyone's progress as a fraction, and
    building each of their scripts to find the denominator is several queries
    per row. This counts the same script arithmetically; a test pins the two
    together so they cannot drift.
    """
    transitions = sum(1 for i, p in enumerate(phases) if i == 0 or p != phases[i - 1])
    return (
        1  # welcome
        + pre_test_pages
        + 1  # SoSci pre-test hand-off
        + (1 if phases and calibration else 0)
        + transitions
        # intro, clip, diagnosis, outro questions, think-aloud
        + 5 * len(phases)
        + 1  # SoSci post-test hand-off
        + 1  # thanks
    )


def _pre_test_step(q: Questionnaire, page: int, page_count: int) -> dict:
    return {
        "kind": "questionnaire",
        "questionnaire_id": q.id,
        "placement": q.placement.value,
        "title": q.title,
        "description": q.description,
        "questions": q.questions,
        # Answered once for the whole run, so there is no case to attach it to.
        "video_id": None,
        "page": page,
        "page_count": page_count,
    }


def _case_video_step(video: Video) -> dict:
    # The right-rail content travels with the step so the case screen has
    # everything it needs in one payload.
    return {
        "kind": "case_video",
        "video_id": video.id,
        "title": video.title,
        "task_description": video.task_description,
        "info_text": video.info_text,
        "student_task_text": video.student_task_text,
        "time_limit_seconds": video.time_limit_seconds,
    }


def _diagnosis_step(video: Video, ratings: Questionnaire | None) -> dict:
    # The rating questions ride along with the write-up: they are one screen and
    # one submission, so a diagnosis can never be stored without its confidence.
    return {
        "kind": "diagnosis",
        "video_id": video.id,
        "title": video.title,
        "task_description": video.task_description,
        "questions": ratings.questions if ratings else [],
    }


def _case_outro_step(video: Video, phase: PhaseType, outro: Questionnaire | None) -> dict:
    return {
        "kind": "case_outro",
        "video_id": video.id,
        "phase_type": phase.value,
        "questionnaire_id": outro.id if outro else None,
        "instruction": outro.description if outro else "",
        "questions": outro.questions if outro else [],
    }


async def _cases(db: AsyncSession, participant: Participant) -> list[tuple[PhaseType, Video]]:
    """The ordered (phase, video) pairs for this participant."""
    rows = (
        await db.execute(
            select(ParticipantVideo, Video)
            .join(Video, Video.id == ParticipantVideo.video_id)
            .where(ParticipantVideo.participant_id == participant.id)
            .order_by(ParticipantVideo.slot_index)
        )
    ).all()
    if rows:
        return [(pv.phase_type, video) for pv, video in rows]

    # Fallback: the whole study's videos, in phase then upload order.
    videos = (
        (await db.execute(select(Video).where(Video.study_id == participant.study_id)))
        .scalars()
        .all()
    )
    return [(v.phase_type, v) for v in default_order(videos)]


async def video_in_run(db: AsyncSession, participant: Participant, video_id: int) -> bool:
    """Is this video part of the participant's run?

    Mirrors _cases(): an explicit sequence wins, and without one the study's
    videos are the run. The per-video endpoints authorise against this, so it
    has to stay in step with the script itself.
    """
    assigned = await db.scalar(
        select(ParticipantVideo.id).where(
            ParticipantVideo.participant_id == participant.id,
            ParticipantVideo.video_id == video_id,
        )
    )
    if assigned is not None:
        return True

    # An explicit sequence exists but this video isn't in it — deny.
    has_sequence = await db.scalar(
        select(ParticipantVideo.id)
        .where(ParticipantVideo.participant_id == participant.id)
        .limit(1)
    )
    if has_sequence is not None:
        return False

    # Running on the study default: any video of their own study counts.
    in_study = await db.scalar(
        select(Video.id).where(Video.id == video_id, Video.study_id == participant.study_id)
    )
    return in_study is not None


async def study_questionnaires(db: AsyncSession, study_id: int) -> list[Questionnaire]:
    return list(
        (
            await db.execute(
                select(Questionnaire)
                .where(Questionnaire.study_id == study_id)
                .order_by(Questionnaire.order_index, Questionnaire.id)
            )
        )
        .scalars()
        .all()
    )


async def build_steps(db: AsyncSession, participant: Participant) -> list[dict]:
    study = await db.get(Study, participant.study_id)
    id_param = study.sosci_id_param if study else "id"

    questionnaires = await study_questionnaires(db, participant.study_id)

    def placed(placement: QuestionnairePlacement) -> list[Questionnaire]:
        # An empty battery is a page the researcher has not written yet — the
        # PCK block is seeded that way — and showing it would be a screen with a
        # heading and nothing under it.
        return [q for q in questionnaires if q.placement == placement and q.questions]

    pre_test = placed(QuestionnairePlacement.pre_test)
    ratings = next(iter(placed(QuestionnairePlacement.diagnosis)), None)
    outro = next(iter(placed(QuestionnairePlacement.case_outro)), None)

    cases = await _cases(db, participant)

    steps: list[dict] = [{"kind": "welcome"}]
    steps.extend(_pre_test_step(q, i + 1, len(pre_test)) for i, q in enumerate(pre_test))
    steps.append(
        _sosci_step("pretest", study.sosci_pretest_url if study else "", id_param, participant.id)
    )
    # Calibrate once, right before the first clip: any earlier and the
    # participant has a SoSci tab to get through before the tracker is used.
    # Skipped entirely when the tracker is calibrated outside the app.
    if cases and get_settings().CALIBRATION_ENABLED:
        steps.append({"kind": "calibration"})

    prev_phase: PhaseType | None = None
    for phase, video in cases:
        if phase != prev_phase:
            steps.append(
                {
                    "kind": "phase_transition",
                    "phase_type": phase.value,
                    "phase_number": _PHASE_NUMBER.get(phase, 0),
                }
            )
            prev_phase = phase

        steps.append({"kind": "case_intro", "phase_type": phase.value, "video_id": video.id})
        steps.append(_case_video_step(video))
        steps.append(_diagnosis_step(video, ratings))
        steps.append(_case_outro_step(video, phase, outro))
        steps.append({"kind": "think_aloud", "video_id": video.id})

    steps.append(
        _sosci_step("posttest", study.sosci_posttest_url if study else "", id_param, participant.id)
    )
    steps.append({"kind": "thanks"})
    return steps


def _sosci_step(variant: str, url: str, id_param: str, participant_id: str) -> dict:
    return {
        "kind": "sosci",
        "variant": variant,
        "url": url,
        "id_param": id_param,
        "participant_id": participant_id,
    }
