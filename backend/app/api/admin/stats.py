"""Statistics: what a study, and what one participant, actually did.

Read-only aggregates over the tables the rest of the admin API writes. Three
levels, because a researcher asks three different questions:

* `/stats/overview` — every study at once. Which ones are running, how far
  along they are, and where data is going missing.
* `/studies/{id}/stats` — one study in depth: its participants, its cases and
  its questionnaires, each with the behaviour recorded against them.
* `/participants/{id}/stats` — one person's run, case by case.

Counting is done in SQL wherever a `GROUP BY` can answer the question. The two
figures it cannot answer — time the clip was playing, time the case screen was
up — are spans between paired events and are reconstructed in
`app.services.stats`, off the same code the gaze replay uses.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import BigInteger, Float, case, cast, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.enums import ParticipantStatus, QuestionnairePlacement
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.researcher import Researcher
from app.models.screen_recording import ScreenRecording
from app.models.session import Session
from app.models.study import Study
from app.models.text_entry import TextEntry
from app.models.video import Video
from app.services.log_data import variable_name
from app.services.session_script import build_steps, count_steps, default_order
from app.services.stats import (
    CASE_EVENTS,
    EMPTY_CASE,
    group_by_case,
    mean,
    median,
    rate,
    summarise_case,
)

from ._common import _participant_or_404, _study_or_404

router = APIRouter()

STATUSES = [s.value for s in ParticipantStatus]


# --- little helpers -------------------------------------------------------


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _num(value: Any) -> float | None:
    """A SQL aggregate as a plain number. `avg` comes back as Decimal, which is
    not JSON, and as None when it averaged over nothing."""
    return round(float(value), 1) if value is not None else None


def _round(value: Any, places: int) -> float | None:
    """A Decimal or float aggregate as a plain number, or None where there was
    nothing to aggregate over."""
    return round(float(value), places) if value is not None else None


def _total(column, as_type: Any = BigInteger) -> Any:
    """SUM that answers 0 rather than NULL when there is nothing to add up.

    Cast back to a number, because Postgres widens SUM over an integer to
    `numeric`. That arrives as a `Decimal`, and a `Decimal` is JSON-encoded as
    a *string* — so a byte count reached the dashboard as text and every
    comparison the formatter made on it was a string comparison.
    """
    return cast(func.coalesce(func.sum(column), 0), as_type)


def _tally(condition) -> Any:
    """How many rows match, as an aggregate that can sit beside other counts."""
    return cast(func.coalesce(func.sum(case((condition, 1), else_=0)), 0), BigInteger)


async def _grouped(db: AsyncSession, key, *aggregates, where=None) -> dict[Any, tuple]:
    """`aggregates` grouped by `key`, as {key: (aggregate, …)}."""
    stmt = select(key, *aggregates).group_by(key)
    if where is not None:
        stmt = stmt.where(where)
    return {row[0]: tuple(row[1:]) for row in (await db.execute(stmt)).all()}


async def _by_study(db: AsyncSession, model, *aggregates, where=None) -> dict[int, tuple]:
    """`aggregates` over one participant-owned table, grouped by study."""
    stmt = (
        select(Participant.study_id, *aggregates)
        .join(model, model.participant_id == Participant.id)
        .group_by(Participant.study_id)
    )
    if where is not None:
        stmt = stmt.where(where)
    return {row[0]: tuple(row[1:]) for row in (await db.execute(stmt)).all()}


def _got(source: dict[Any, tuple], key: Any, default: tuple) -> tuple:
    """A grouped row, or `default` for a key that produced no rows at all.

    The default is spelled out at every call because the shapes are mixed: a
    count that nobody contributed to is 0, but an average over nothing is None
    — and 0.0 would read as "they wrote empty notes".
    """
    return source.get(key) or default


async def _activity(db: AsyncSession, days: int, study_id: int | None = None) -> list[dict]:
    """Events and distinct active participants per day, most recent last."""
    day = func.date(InteractionLog.created_at).label("day")
    stmt = (
        select(day, func.count(), func.count(distinct(InteractionLog.participant_id)))
        .where(InteractionLog.created_at >= datetime.now(UTC) - timedelta(days=days))
        .group_by(day)
        .order_by(day)
    )
    if study_id is not None:
        stmt = stmt.join(Participant, Participant.id == InteractionLog.participant_id).where(
            Participant.study_id == study_id
        )
    return [
        {"date": d.isoformat(), "events": events, "participants": people}
        for d, events, people in (await db.execute(stmt)).all()
    ]


async def _event_types(db: AsyncSession, study_id: int | None = None) -> list[dict]:
    """How often each kind of event was recorded, commonest first. The data
    dictionary's name for it travels along, since that is what an analysis
    joins on."""
    stmt = (
        select(
            InteractionLog.event_type,
            func.count(),
            func.count(distinct(InteractionLog.participant_id)),
        )
        .group_by(InteractionLog.event_type)
        .order_by(func.count().desc())
    )
    if study_id is not None:
        stmt = stmt.join(Participant, Participant.id == InteractionLog.participant_id).where(
            Participant.study_id == study_id
        )
    return [
        {
            "event_type": name,
            "variable_name": variable_name(name),
            "count": count,
            "participants": people,
        }
        for name, count, people in (await db.execute(stmt)).all()
    ]


# --- every study at once --------------------------------------------------


@router.get("/stats/overview")
async def overview_stats(
    days: int = Query(30, ge=1, le=365),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    studies = (await db.execute(select(Study).order_by(Study.id.desc()))).scalars().all()

    statuses: dict[int, dict[str, int]] = defaultdict(lambda: dict.fromkeys(STATUSES, 0))
    for study_id, status, count in (
        await db.execute(
            select(Participant.study_id, Participant.status, func.count()).group_by(
                Participant.study_id, Participant.status
            )
        )
    ).all():
        statuses[study_id][status.value] = count

    videos = await _grouped(
        db,
        Video.study_id,
        func.count(),
        func.count(Video.gcp_filename),
        _total(Video.duration_seconds, Float),
    )
    questionnaires = await _grouped(db, Questionnaire.study_id, func.count())

    notes = await _by_study(db, Note, func.count(), func.count(distinct(Note.participant_id)))
    diagnoses = await _by_study(db, TextEntry, func.count(), where=TextEntry.kind == "diagnosis")
    responses = await _by_study(db, QuestionnaireResponse, func.count())
    events = await _by_study(db, InteractionLog, func.count(), func.max(InteractionLog.created_at))
    gaze = await _by_study(db, GazeRecording, func.count(), _total(GazeRecording.sample_count))
    screens = await _by_study(
        db,
        ScreenRecording,
        func.count(),
        _tally(ScreenRecording.status == "stored"),
        _tally(ScreenRecording.status == "failed"),
        _total(ScreenRecording.byte_size),
    )
    calibrations = await _by_study(
        db,
        GazeCalibration,
        func.count(),
        _tally(GazeCalibration.status == "success"),
        func.avg(GazeCalibration.mean_offset),
    )
    sessions = await _by_study(
        db,
        Session,
        func.count(),
        func.count(Session.completed_at),
        func.avg(func.extract("epoch", Session.completed_at - Session.created_at)),
    )

    rows = []
    for study in studies:
        counts = statuses[study.id]
        people = sum(counts.values())
        video_count, with_file, duration = _got(videos, study.id, (0, 0, 0))
        note_count, note_writers = _got(notes, study.id, (0, 0))
        event_count, last_event = events.get(study.id) or (0, None)
        started, finished, seconds = sessions.get(study.id) or (0, 0, None)
        gaze_count, samples = _got(gaze, study.id, (0, 0))
        screen_count, stored, failed, screen_bytes = _got(screens, study.id, (0, 0, 0, 0))
        attempts, calibrated, offset = calibrations.get(study.id) or (0, 0, None)

        rows.append(
            {
                "id": study.id,
                "name": study.name,
                "is_active": study.is_active,
                "created_at": _iso(study.created_at),
                "participants": people,
                **counts,
                # Of the people who logged in at all, how many reached the end.
                "started": started,
                "finished": finished,
                "completion_rate": rate(counts["completed"], people),
                "avg_session_minutes": (
                    _round(float(seconds) / 60 if seconds is not None else None, 1)
                ),
                "videos": video_count,
                "videos_with_file": with_file,
                "video_seconds": round(float(duration or 0), 1),
                "questionnaires": _got(questionnaires, study.id, (0,))[0],
                "notes": note_count,
                "note_writers": note_writers,
                "diagnoses": _got(diagnoses, study.id, (0,))[0],
                "responses": _got(responses, study.id, (0,))[0],
                "events": event_count,
                "last_activity_at": _iso(last_event),
                "gaze_recordings": gaze_count,
                "gaze_samples": samples,
                "screen_recordings": screen_count,
                "screens_stored": stored,
                "screens_failed": failed,
                "screen_bytes": screen_bytes,
                "calibrations": attempts,
                "calibrations_ok": calibrated,
                "mean_offset": _round(offset, 4),
            }
        )

    def summed(field: str) -> int:
        return sum(row[field] or 0 for row in rows)

    researchers = await db.scalar(select(func.count()).select_from(Researcher))
    return {
        "generated_at": _iso(datetime.now(UTC)),
        "totals": {
            "studies": len(studies),
            "active_studies": sum(1 for s in studies if s.is_active),
            "researchers": researchers or 0,
            "participants": summed("participants"),
            **{status: summed(status) for status in STATUSES},
            "started": summed("started"),
            "finished": summed("finished"),
            "completion_rate": rate(summed("completed"), summed("participants")),
            "videos": summed("videos"),
            "videos_with_file": summed("videos_with_file"),
            "questionnaires": summed("questionnaires"),
            "notes": summed("notes"),
            "diagnoses": summed("diagnoses"),
            "responses": summed("responses"),
            "events": summed("events"),
            "gaze_recordings": summed("gaze_recordings"),
            "gaze_samples": summed("gaze_samples"),
            "screen_recordings": summed("screen_recordings"),
            "screens_stored": summed("screens_stored"),
            "screens_failed": summed("screens_failed"),
            "screen_bytes": summed("screen_bytes"),
            "calibrations": summed("calibrations"),
            "calibrations_ok": summed("calibrations_ok"),
        },
        "studies": rows,
        "activity": await _activity(db, days),
        "events_by_type": await _event_types(db),
    }


# --- one study ------------------------------------------------------------


@router.get("/studies/{study_id}/stats")
async def study_stats(
    study_id: int,
    days: int = Query(30, ge=1, le=365),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    study = await _study_or_404(db, study_id)
    calibration_step = get_settings().CALIBRATION_ENABLED

    participants = (
        (
            await db.execute(
                select(Participant).where(Participant.study_id == study_id).order_by(Participant.id)
            )
        )
        .scalars()
        .all()
    )
    ids = [p.id for p in participants]
    videos = (await db.execute(select(Video).where(Video.study_id == study_id))).scalars().all()
    batteries = (
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

    if not ids:
        return _empty_study_stats(study, videos, batteries, days, db)

    mine = Participant.study_id == study_id

    # --- per participant, for the roster table ---------------------------
    sessions = {
        s.participant_id: s
        for s in (
            await db.execute(select(Session).where(Session.participant_id.in_(ids)))
        ).scalars()
    }
    p_notes = await _grouped(
        db,
        Note.participant_id,
        func.count(),
        _total(func.length(Note.text)),
        where=Note.participant_id.in_(ids),
    )
    p_diagnoses = await _grouped(
        db,
        TextEntry.participant_id,
        func.count(),
        where=TextEntry.participant_id.in_(ids) & (TextEntry.kind == "diagnosis"),
    )
    p_responses = await _grouped(
        db,
        QuestionnaireResponse.participant_id,
        func.count(),
        where=QuestionnaireResponse.participant_id.in_(ids),
    )
    p_events = await _grouped(
        db,
        InteractionLog.participant_id,
        func.count(),
        func.min(InteractionLog.created_at),
        func.max(InteractionLog.created_at),
        where=InteractionLog.participant_id.in_(ids),
    )
    p_gaze = await _grouped(
        db,
        GazeRecording.participant_id,
        func.count(),
        _total(GazeRecording.sample_count),
        where=GazeRecording.participant_id.in_(ids),
    )
    p_screens = await _grouped(
        db,
        ScreenRecording.participant_id,
        func.count(),
        _tally(ScreenRecording.status == "stored"),
        _tally(ScreenRecording.status == "failed"),
        _total(ScreenRecording.byte_size),
        where=ScreenRecording.participant_id.in_(ids),
    )
    p_calibration = await _grouped(
        db,
        GazeCalibration.participant_id,
        func.count(),
        func.min(GazeCalibration.mean_offset),
        where=GazeCalibration.participant_id.in_(ids),
    )

    # The step denominator. Built arithmetically rather than by assembling every
    # participant's script, which is several queries each.
    pre_pages = sum(
        1 for q in batteries if q.placement == QuestionnairePlacement.pre_test and q.questions
    )
    default_phases = [v.phase_type for v in default_order(videos)]
    assigned: dict[str, list] = defaultdict(list)
    for pid, phase in (
        await db.execute(
            select(ParticipantVideo.participant_id, ParticipantVideo.phase_type)
            .where(ParticipantVideo.participant_id.in_(ids))
            .order_by(ParticipantVideo.participant_id, ParticipantVideo.slot_index)
        )
    ).all():
        assigned[pid].append(phase)

    # --- the spans SQL cannot count --------------------------------------
    case_rows = (
        await db.execute(
            select(
                InteractionLog.participant_id,
                InteractionLog.video_id,
                InteractionLog.event_type,
                InteractionLog.payload,
                InteractionLog.client_ts,
                InteractionLog.created_at,
            )
            .join(Participant, Participant.id == InteractionLog.participant_id)
            .where(mine, InteractionLog.event_type.in_(CASE_EVENTS))
            .order_by(InteractionLog.id)
        )
    ).all()
    spans = {key: summarise_case(rows) for key, rows in group_by_case(case_rows).items()}

    roster = []
    for p in participants:
        session = sessions.get(p.id)
        phases = assigned.get(p.id) or default_phases
        total_steps = count_steps(pre_pages, phases, calibration_step)
        step = session.current_step_index if session else 0
        note_count, note_chars = _got(p_notes, p.id, (0, 0))
        event_count, first_event, last_event = p_events.get(p.id) or (0, None, None)
        gaze_count, samples = _got(p_gaze, p.id, (0, 0))
        screen_count, stored, failed, screen_bytes = _got(p_screens, p.id, (0, 0, 0, 0))
        attempts, best_offset = p_calibration.get(p.id) or (0, None)
        watched = sum(s["watch_seconds"] for (pid, _), s in spans.items() if pid == p.id)

        roster.append(
            {
                "id": p.id,
                "status": p.status.value,
                "created_at": _iso(p.created_at),
                "cases": len(phases),
                "assigned_sequence": bool(assigned.get(p.id)),
                "step": step,
                "total_steps": total_steps,
                "progress": rate(step, total_steps),
                "started_at": _iso(session.created_at) if session else None,
                "completed_at": _iso(session.completed_at) if session else None,
                "session_minutes": _minutes(session),
                "first_event_at": _iso(first_event),
                "last_event_at": _iso(last_event),
                "events": event_count,
                "notes": note_count,
                "note_chars": note_chars,
                "diagnoses": _got(p_diagnoses, p.id, (0,))[0],
                "responses": _got(p_responses, p.id, (0,))[0],
                "watch_seconds": round(watched, 1),
                "gaze_recordings": gaze_count,
                "gaze_samples": samples,
                "screens_stored": stored,
                "screens_failed": failed,
                "screen_bytes": screen_bytes,
                "calibrations": attempts,
                "best_offset": _round(best_offset, 4),
            }
        )

    # --- per case ---------------------------------------------------------
    v_events: dict[tuple[int, str], tuple[int, int]] = {}
    for video_id, event_type, count, people in (
        await db.execute(
            select(
                InteractionLog.video_id,
                InteractionLog.event_type,
                func.count(),
                func.count(distinct(InteractionLog.participant_id)),
            )
            .join(Participant, Participant.id == InteractionLog.participant_id)
            .where(mine, InteractionLog.video_id.is_not(None))
            .group_by(InteractionLog.video_id, InteractionLog.event_type)
        )
    ).all():
        v_events[(video_id, event_type)] = (count, people)

    v_notes = await _grouped(
        db,
        Note.video_id,
        func.count(),
        func.count(distinct(Note.participant_id)),
        func.avg(func.length(Note.text)),
        where=Note.participant_id.in_(ids),
    )
    v_diagnoses = await _grouped(
        db,
        TextEntry.video_id,
        func.count(),
        func.avg(func.length(TextEntry.text)),
        func.avg(TextEntry.time_spent_seconds),
        where=TextEntry.participant_id.in_(ids) & (TextEntry.kind == "diagnosis"),
    )
    v_gaze = await _grouped(
        db,
        GazeRecording.video_id,
        func.count(),
        _total(GazeRecording.sample_count),
        func.count(distinct(GazeRecording.participant_id)),
        where=GazeRecording.participant_id.in_(ids),
    )
    v_screens = await _grouped(
        db,
        ScreenRecording.video_id,
        func.count(),
        _tally(ScreenRecording.status == "stored"),
        _tally(ScreenRecording.status == "failed"),
        _total(ScreenRecording.byte_size),
        where=ScreenRecording.participant_id.in_(ids),
    )
    v_assigned = await _grouped(
        db,
        ParticipantVideo.video_id,
        func.count(),
        where=ParticipantVideo.participant_id.in_(ids),
    )

    def counted(video_id: int, event_type: str) -> int:
        return v_events.get((video_id, event_type), (0, 0))[0]

    case_stats = []
    for video in default_order(videos):
        seen = v_events.get((video.id, "case_screen_entered"), (0, 0))[1]
        watch = [s["watch_seconds"] for (_, vid), s in spans.items() if vid == video.id]
        on_screen = [s["on_screen_seconds"] for (_, vid), s in spans.items() if vid == video.id]
        reached = [s["max_playhead_seconds"] for (_, vid), s in spans.items() if vid == video.id]
        note_count, note_writers, note_length = _got(v_notes, video.id, (0, 0, None))
        diag_count, diag_length, diag_seconds = _got(v_diagnoses, video.id, (0, None, None))
        gaze_count, samples, gaze_people = _got(v_gaze, video.id, (0, 0, 0))
        screen_count, stored, failed, screen_bytes = _got(v_screens, video.id, (0, 0, 0, 0))

        case_stats.append(
            {
                "video_id": video.id,
                "title": video.title,
                "phase_type": video.phase_type.value,
                "duration_seconds": video.duration_seconds,
                "time_limit_seconds": video.time_limit_seconds,
                "has_file": bool(video.gcp_filename),
                "assigned": _got(v_assigned, video.id, (0,))[0],
                "viewers": seen,
                "avg_watch_seconds": mean(watch),
                "median_watch_seconds": median(watch),
                "avg_on_screen_seconds": mean(on_screen),
                # Of the clip's length, how much the average participant saw.
                "avg_coverage": (
                    rate(mean(reached) or 0, video.duration_seconds)
                    if video.duration_seconds
                    else None
                ),
                "plays": counted(video.id, "video_started") + counted(video.id, "video_resumed"),
                "pauses": counted(video.id, "video_paused"),
                "seeks": counted(video.id, "video_seeked"),
                "replays": counted(video.id, "video_replayed"),
                "completions": counted(video.id, "video_completed"),
                "info_opens": counted(video.id, "info_opened"),
                "task_opens": counted(video.id, "student_task_opened"),
                "notes": note_count,
                "note_writers": note_writers,
                "avg_note_chars": _num(note_length),
                "diagnoses": diag_count,
                "avg_diagnosis_chars": _num(diag_length),
                "avg_diagnosis_seconds": _num(diag_seconds),
                "gaze_recordings": gaze_count,
                "gaze_participants": gaze_people,
                "gaze_samples": samples,
                "screen_recordings": screen_count,
                "screens_stored": stored,
                "screens_failed": failed,
                "screen_bytes": screen_bytes,
            }
        )

    # --- questionnaires ---------------------------------------------------
    q_responses = await _grouped(
        db,
        QuestionnaireResponse.questionnaire_id,
        func.count(),
        func.count(distinct(QuestionnaireResponse.participant_id)),
        func.avg(QuestionnaireResponse.time_spent_seconds),
        func.max(QuestionnaireResponse.created_at),
        where=QuestionnaireResponse.participant_id.in_(ids),
    )
    battery_stats = []
    for q in batteries:
        count, people, seconds, latest = q_responses.get(q.id) or (0, 0, None, None)
        # A per-case battery is answered once per case, a pre-test page once per
        # run; the denominator has to follow, or completion reads over 100%.
        expected = len(participants) * (
            1 if q.placement == QuestionnairePlacement.pre_test else max(len(videos), 1)
        )
        battery_stats.append(
            {
                "id": q.id,
                "title": q.title,
                "placement": q.placement.value,
                "questions": len(q.questions or []),
                "responses": count,
                "participants": people,
                "expected": expected,
                "completion": rate(count, expected),
                "avg_seconds": _num(seconds),
                "last_response_at": _iso(latest),
            }
        )

    # --- calibration ------------------------------------------------------
    by_status: dict[str, dict[str, Any]] = {}
    for status, count, people, avg_offset, best, worst, degrees in (
        await db.execute(
            select(
                GazeCalibration.status,
                func.count(),
                func.count(distinct(GazeCalibration.participant_id)),
                func.avg(GazeCalibration.mean_offset),
                func.min(GazeCalibration.mean_offset),
                func.max(GazeCalibration.mean_offset),
                func.avg(GazeCalibration.mean_offset_degrees),
            )
            .join(Participant, Participant.id == GazeCalibration.participant_id)
            .where(mine)
            .group_by(GazeCalibration.status)
        )
    ).all():
        by_status[status] = {
            "attempts": count,
            "participants": people,
            "avg_offset": _round(avg_offset, 4),
            "best_offset": _round(best, 4),
            "worst_offset": _round(worst, 4),
            "avg_offset_degrees": _round(degrees, 2),
        }
    calibration = {
        "attempts": sum(s["attempts"] for s in by_status.values()),
        # Distinct people, not attempts: a repeat calibration is one participant
        # the tracker had trouble with, not two who were measured.
        "participants": await db.scalar(
            select(func.count(distinct(GazeCalibration.participant_id)))
            .join(Participant, Participant.id == GazeCalibration.participant_id)
            .where(mine)
        )
        or 0,
        "by_status": by_status,
    }

    finished = [r for r in roster if r["session_minutes"] is not None]
    minutes = [r["session_minutes"] for r in finished]
    return {
        "generated_at": _iso(datetime.now(UTC)),
        "study": {
            "id": study.id,
            "name": study.name,
            "description": study.description,
            "is_active": study.is_active,
            "created_at": _iso(study.created_at),
        },
        "participants": {
            "total": len(participants),
            **{status: sum(1 for r in roster if r["status"] == status) for status in STATUSES},
            "started": sum(1 for r in roster if r["started_at"]),
            "completed_sessions": len(finished),
            "completion_rate": rate(
                sum(1 for r in roster if r["status"] == "completed"), len(participants)
            ),
            "avg_progress": mean([r["progress"] or 0 for r in roster]),
            "avg_session_minutes": mean(minutes),
            "median_session_minutes": median(minutes),
            "with_gaze": sum(1 for r in roster if r["gaze_recordings"]),
            "with_screen": sum(1 for r in roster if r["screens_stored"]),
            "with_calibration": sum(1 for r in roster if r["calibrations"]),
            "never_started": sum(1 for r in roster if not r["events"]),
        },
        "data": {
            "notes": sum(r["notes"] for r in roster),
            "note_chars": sum(r["note_chars"] for r in roster),
            "diagnoses": sum(r["diagnoses"] for r in roster),
            "responses": sum(r["responses"] for r in roster),
            "events": sum(r["events"] for r in roster),
            "gaze_recordings": sum(r["gaze_recordings"] for r in roster),
            "gaze_samples": sum(r["gaze_samples"] for r in roster),
            "screens_stored": sum(r["screens_stored"] for r in roster),
            "screens_failed": sum(r["screens_failed"] for r in roster),
            "screen_bytes": sum(r["screen_bytes"] for r in roster),
            "watch_seconds": round(sum(r["watch_seconds"] for r in roster), 1),
        },
        "cases": case_stats,
        "questionnaires": battery_stats,
        "calibration": calibration,
        "roster": roster,
        "activity": await _activity(db, days, study_id),
        "events_by_type": await _event_types(db, study_id),
    }


def _minutes(session: Session | None) -> float | None:
    if session is None or session.completed_at is None:
        return None
    return round((session.completed_at - session.created_at).total_seconds() / 60, 1)


def _empty_study_stats(study, videos, batteries, days, db) -> dict[str, Any]:
    """A study nobody has been enrolled in yet. Every aggregate below would
    group over an empty `IN ()`, so answer the shape directly rather than run a
    dozen queries that can only come back empty."""
    return {
        "generated_at": _iso(datetime.now(UTC)),
        "study": {
            "id": study.id,
            "name": study.name,
            "description": study.description,
            "is_active": study.is_active,
            "created_at": _iso(study.created_at),
        },
        "participants": {
            "total": 0,
            **dict.fromkeys(STATUSES, 0),
            "started": 0,
            "completed_sessions": 0,
            "completion_rate": None,
            "avg_progress": None,
            "avg_session_minutes": None,
            "median_session_minutes": None,
            "with_gaze": 0,
            "with_screen": 0,
            "with_calibration": 0,
            "never_started": 0,
        },
        "data": dict.fromkeys(
            (
                "notes",
                "note_chars",
                "diagnoses",
                "responses",
                "events",
                "gaze_recordings",
                "gaze_samples",
                "screens_stored",
                "screens_failed",
                "screen_bytes",
                "watch_seconds",
            ),
            0,
        ),
        "cases": [
            {
                "video_id": v.id,
                "title": v.title,
                "phase_type": v.phase_type.value,
                "duration_seconds": v.duration_seconds,
                "time_limit_seconds": v.time_limit_seconds,
                "has_file": bool(v.gcp_filename),
                "assigned": 0,
                "viewers": 0,
                "avg_watch_seconds": None,
                "median_watch_seconds": None,
                "avg_on_screen_seconds": None,
                "avg_coverage": None,
                "plays": 0,
                "pauses": 0,
                "seeks": 0,
                "replays": 0,
                "completions": 0,
                "info_opens": 0,
                "task_opens": 0,
                "notes": 0,
                "note_writers": 0,
                "avg_note_chars": None,
                "diagnoses": 0,
                "avg_diagnosis_chars": None,
                "avg_diagnosis_seconds": None,
                "gaze_recordings": 0,
                "gaze_participants": 0,
                "gaze_samples": 0,
                "screen_recordings": 0,
                "screens_stored": 0,
                "screens_failed": 0,
                "screen_bytes": 0,
            }
            for v in default_order(videos)
        ],
        "questionnaires": [
            {
                "id": q.id,
                "title": q.title,
                "placement": q.placement.value,
                "questions": len(q.questions or []),
                "responses": 0,
                "participants": 0,
                "expected": 0,
                "completion": None,
                "avg_seconds": None,
                "last_response_at": None,
            }
            for q in batteries
        ],
        "calibration": {"attempts": 0, "participants": 0, "by_status": {}},
        "roster": [],
        "activity": [],
        "events_by_type": [],
    }


# --- one participant ------------------------------------------------------


@router.get("/participants/{participant_id}/stats")
async def participant_stats(
    participant_id: str,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    p = await _participant_or_404(db, participant_id)
    study = await db.get(Study, p.study_id)
    session = await db.scalar(select(Session).where(Session.participant_id == p.id))

    # One participant, so the real script rather than the arithmetic: it also
    # names the step they are sitting on.
    steps = await build_steps(db, p)
    step_index = session.current_step_index if session else 0
    current = steps[step_index] if 0 <= step_index < len(steps) else None

    titles = {
        v.id: v
        for v in (await db.execute(select(Video).where(Video.study_id == p.study_id))).scalars()
    }
    sequence = (
        (
            await db.execute(
                select(ParticipantVideo)
                .where(ParticipantVideo.participant_id == p.id)
                .order_by(ParticipantVideo.slot_index)
            )
        )
        .scalars()
        .all()
    )
    ordered = (
        [(pv.slot_index, pv.phase_type, titles.get(pv.video_id)) for pv in sequence]
        if sequence
        else [(i, v.phase_type, v) for i, v in enumerate(default_order(list(titles.values())))]
    )

    mine = InteractionLog.participant_id == p.id
    event_count, first_event, last_event = (
        await db.execute(
            select(
                func.count(),
                func.min(InteractionLog.created_at),
                func.max(InteractionLog.created_at),
            ).where(mine)
        )
    ).one()

    by_type = [
        {
            "event_type": name,
            "variable_name": variable_name(name),
            "count": count,
            "first_at": _iso(first),
            "last_at": _iso(last),
        }
        for name, count, first, last in (
            await db.execute(
                select(
                    InteractionLog.event_type,
                    func.count(),
                    func.min(InteractionLog.created_at),
                    func.max(InteractionLog.created_at),
                )
                .where(mine)
                .group_by(InteractionLog.event_type)
                .order_by(func.count().desc())
            )
        ).all()
    ]

    per_video: dict[tuple[int, str], int] = {}
    for video_id, event_type, count in (
        await db.execute(
            select(InteractionLog.video_id, InteractionLog.event_type, func.count())
            .where(mine, InteractionLog.video_id.is_not(None))
            .group_by(InteractionLog.video_id, InteractionLog.event_type)
        )
    ).all():
        per_video[(video_id, event_type)] = count

    spans = {
        video_id: summarise_case(rows)
        for (_, video_id), rows in group_by_case(
            (
                await db.execute(
                    select(
                        InteractionLog.participant_id,
                        InteractionLog.video_id,
                        InteractionLog.event_type,
                        InteractionLog.payload,
                        InteractionLog.client_ts,
                        InteractionLog.created_at,
                    )
                    .where(mine, InteractionLog.event_type.in_(CASE_EVENTS))
                    .order_by(InteractionLog.id)
                )
            ).all()
        ).items()
    }

    notes = await _grouped(
        db,
        Note.video_id,
        func.count(),
        _total(func.length(Note.text)),
        func.max(Note.created_at),
        func.max(Note.video_time_seconds),
        where=Note.participant_id == p.id,
    )
    diagnoses = {
        row.video_id: row
        for row in (
            await db.execute(
                select(TextEntry)
                .where(TextEntry.participant_id == p.id, TextEntry.kind == "diagnosis")
                .order_by(TextEntry.id)
            )
        ).scalars()
    }
    gaze = await _grouped(
        db,
        GazeRecording.video_id,
        func.count(),
        _total(GazeRecording.sample_count),
        func.min(GazeRecording.started_at),
        func.max(GazeRecording.completed_at),
        func.max(GazeRecording.sampling_rate_hz),
        where=GazeRecording.participant_id == p.id,
    )
    screens: dict[int, ScreenRecording] = {
        # Ascending, so the last write per case is the newest capture of it.
        recording.video_id: recording
        for recording in (
            await db.execute(
                select(ScreenRecording)
                .where(ScreenRecording.participant_id == p.id)
                .order_by(ScreenRecording.started_at)
            )
        ).scalars()
    }

    responses = (
        await db.execute(
            select(QuestionnaireResponse, Questionnaire)
            .join(Questionnaire, Questionnaire.id == QuestionnaireResponse.questionnaire_id)
            .where(QuestionnaireResponse.participant_id == p.id)
            .order_by(QuestionnaireResponse.id)
        )
    ).all()
    answered_cases = {
        (r.video_id, q.placement.value) for r, q in responses if r.video_id is not None
    }

    cases = []
    for slot, phase, video in ordered:
        if video is None:
            continue
        span = spans.get(video.id, EMPTY_CASE)
        count = per_video.get
        note_count, note_chars, last_note, deepest_note = _got(notes, video.id, (0, 0, None, None))
        recordings, samples, gaze_start, gaze_end, hz = _got(
            gaze, video.id, (0, 0, None, None, None)
        )
        screen = screens.get(video.id)
        entry = diagnoses.get(video.id)
        # A rate of samples against the time the screen was being recorded says
        # whether the tracker was actually seeing the participant's eyes.
        expected = (span["on_screen_seconds"] or 0) * (hz or 0)

        cases.append(
            {
                "slot_index": slot,
                "video_id": video.id,
                "title": video.title,
                "phase_type": phase.value if hasattr(phase, "value") else str(phase),
                "duration_seconds": video.duration_seconds,
                "time_limit_seconds": video.time_limit_seconds,
                "entered": bool(count((video.id, "case_screen_entered"), 0)),
                **span,
                "coverage": (
                    rate(span["max_playhead_seconds"], video.duration_seconds)
                    if video.duration_seconds
                    else None
                ),
                "plays": count((video.id, "video_started"), 0)
                + count((video.id, "video_resumed"), 0),
                "pauses": count((video.id, "video_paused"), 0),
                "seeks": count((video.id, "video_seeked"), 0),
                "replays": count((video.id, "video_replayed"), 0),
                "completed": bool(count((video.id, "video_completed"), 0)),
                "info_opens": count((video.id, "info_opened"), 0),
                "task_opens": count((video.id, "student_task_opened"), 0),
                "notes_focused": count((video.id, "notes_focused"), 0),
                "typing_bursts": count((video.id, "notes_typed"), 0),
                "notes": {
                    "snapshots": note_count,
                    "chars": note_chars,
                    "last_at": _iso(last_note),
                    "last_video_time": _num(deepest_note),
                },
                "diagnosis": (
                    {
                        "chars": len(entry.text),
                        "words": len(entry.text.split()),
                        "seconds": entry.time_spent_seconds,
                        "submitted_at": _iso(entry.created_at),
                    }
                    if entry
                    else None
                ),
                "outro_answered": (video.id, "case_outro") in answered_cases,
                "ratings_answered": (video.id, "diagnosis") in answered_cases,
                "gaze": {
                    "recordings": recordings,
                    "samples": samples,
                    "sampling_rate_hz": hz or None,
                    "expected_samples": int(expected) or None,
                    "yield": rate(samples, expected) if expected else None,
                    "started_at": _iso(gaze_start),
                    "completed_at": _iso(gaze_end),
                },
                "screen": (
                    {
                        "id": screen.id,
                        "status": screen.status,
                        "error": screen.error,
                        "duration_ms": screen.duration_ms,
                        "byte_size": screen.byte_size,
                        "width": screen.width,
                        "height": screen.height,
                        "fps": screen.fps,
                    }
                    if screen
                    else None
                ),
            }
        )

    calibrations = [
        {
            "id": c.id,
            "status": c.status,
            "mean_offset": _round(c.mean_offset, 4),
            "mean_offset_degrees": (_round(c.mean_offset_degrees, 2)),
            "points": len(c.points or []),
            "created_at": _iso(c.created_at),
        }
        for c in (
            await db.execute(
                select(GazeCalibration)
                .where(GazeCalibration.participant_id == p.id)
                .order_by(GazeCalibration.id)
            )
        ).scalars()
    ]

    return {
        "generated_at": _iso(datetime.now(UTC)),
        "id": p.id,
        "study_id": p.study_id,
        "study_name": study.name if study else "",
        "status": p.status.value,
        "created_at": _iso(p.created_at),
        "session": {
            "started_at": _iso(session.created_at) if session else None,
            "completed_at": _iso(session.completed_at) if session else None,
            "minutes": _minutes(session),
            "step": step_index,
            "total_steps": len(steps),
            "progress": rate(step_index, len(steps)),
            "current_step": current["kind"] if current else None,
            "assigned_sequence": bool(sequence),
        },
        "activity": {
            "events": event_count,
            "first_at": _iso(first_event),
            "last_at": _iso(last_event),
            "minutes": (
                round((last_event - first_event).total_seconds() / 60, 1)
                if first_event and last_event
                else None
            ),
        },
        "totals": {
            "cases": len(cases),
            "cases_entered": sum(1 for c in cases if c["entered"]),
            "cases_completed": sum(1 for c in cases if c["completed"]),
            "watch_seconds": round(sum(c["watch_seconds"] for c in cases), 1),
            "on_screen_seconds": round(sum(c["on_screen_seconds"] for c in cases), 1),
            "notes": sum(c["notes"]["snapshots"] for c in cases),
            "note_chars": sum(c["notes"]["chars"] for c in cases),
            "diagnoses": sum(1 for c in cases if c["diagnosis"]),
            "diagnosis_words": sum(c["diagnosis"]["words"] for c in cases if c["diagnosis"]),
            "responses": len(responses),
            "gaze_samples": sum(c["gaze"]["samples"] for c in cases),
            "screens_stored": sum(
                1 for c in cases if c["screen"] and c["screen"]["status"] == "stored"
            ),
            "screens_failed": sum(
                1 for c in cases if c["screen"] and c["screen"]["status"] == "failed"
            ),
            "screen_bytes": sum((c["screen"]["byte_size"] or 0) for c in cases if c["screen"]),
        },
        "cases": cases,
        "questionnaires": [
            {
                "id": q.id,
                "response_id": r.id,
                "title": q.title,
                "placement": q.placement.value,
                "video_id": r.video_id,
                "video_title": titles[r.video_id].title if r.video_id in titles else None,
                "questions": len(q.questions or []),
                "answered": len(r.answers or {}),
                "seconds": r.time_spent_seconds,
                "created_at": _iso(r.created_at),
            }
            for r, q in responses
        ],
        "calibrations": calibrations,
        "events_by_type": by_type,
    }
