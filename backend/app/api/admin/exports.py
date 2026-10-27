"""CSV exports — the raw data as the researchers take it away.

Streamed from a server-side cursor: the interaction log is unbounded, and
building a study's worth of it in memory before sending a byte is how an
export falls over just when it matters.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, case, exists, func, select
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool
from starlette.responses import Response, StreamingResponse

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.enums import PhaseType, QuestionnairePlacement
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.questionnaire_timing import QuestionnaireVisit, SectionAttempt
from app.models.researcher import Researcher
from app.models.text_entry import TextEntry
from app.models.video import Video
from app.models.video_set import VideoSet
from app.schemas.admin import ExportInfo
from app.services.gaze_export import GAZE_COLUMNS, GazeStorageError, check_storage, csv_batches
from app.services.log_data import (
    completed_step_label,
    playhead_seconds,
    seek_origin_seconds,
    variable_name,
)
from app.services.timecode import timecode

from ._common import _study_or_404

router = APIRouter()


# Excel and LibreOffice treat a cell starting with any of these as a formula.
_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")


def _defuse(value: object) -> object:
    """Stop participant text being executed by whoever opens the export.

    Notes, diagnoses and free-text answers are written by participants, so a
    cell beginning `=` is theirs to choose. Numbers are written as numbers and
    are not affected.
    """
    if isinstance(value, str) and value.startswith(_FORMULA_LEAD):
        return "'" + value
    return value


CSV_BATCH = 500


def _csv_stream(
    db: AsyncSession, filename: str, header: list[str], stmt, shape
) -> StreamingResponse:
    """Stream an export straight from a server-side cursor.

    The interaction log is the table that grows without limit; collecting a
    study's worth of it into a list and joining it into one string put the whole
    export in memory twice before a byte reached the researcher.
    """

    async def rows():
        buf = io.StringIO()
        writer = csv.writer(buf)
        # utf-8-sig: without the BOM Excel reads the German text as latin-1.
        yield b"\xef\xbb\xbf"

        writer.writerow(header)
        result = await db.stream(stmt.execution_options(yield_per=CSV_BATCH))
        async for row in result:
            writer.writerow([_defuse(cell) for cell in shape(row)])
            if buf.tell() > 64 * 1024:
                yield buf.getvalue().encode("utf-8")
                buf.seek(0)
                buf.truncate(0)
        yield buf.getvalue().encode("utf-8")

    return StreamingResponse(
        rows(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _chosen_participants(
    db: AsyncSession, study_id: int, raw: list[str] | None
) -> list[str] | None:
    """The participants an export is limited to, or None for the whole study.

    The researchers asked to pull one new person's data without downloading
    everyone again. Ids are checked against the study rather than dropped
    quietly: a typo would otherwise produce a file that lacks someone and
    says nothing about it.
    """
    wanted: list[str] = []
    for raw_id in raw or []:
        pid = raw_id.strip()
        if pid and pid not in wanted:
            wanted.append(pid)
    if not wanted:
        return None

    known = set(
        (
            await db.execute(
                select(Participant.id).where(
                    Participant.study_id == study_id, Participant.id.in_(wanted)
                )
            )
        )
        .scalars()
        .all()
    )
    unknown = [pid for pid in wanted if pid not in known]
    if unknown:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Not participants of this study: {unknown}"
        )
    return wanted


def _only(stmt, column, participant_ids: list[str] | None):
    """Narrow a per-participant query to the chosen people, or leave it whole."""
    return stmt.where(column.in_(participant_ids)) if participant_ids else stmt


def _filename(kind: str, filename: str, participant_ids: list[str] | None) -> str:
    """`events.csv` for the whole study, `events-TN-006.csv` for one person,
    `events-auswahl.csv` for a hand-picked few, so files on a laptop do not
    overwrite each other. Ids are held to a filename-safe charset on creation.
    The video list is not per person, so its name never changes.
    """
    if not participant_ids or kind == "videos":
        return filename
    stem, ext = filename.rsplit(".", 1)
    suffix = participant_ids[0] if len(participant_ids) == 1 else "auswahl"
    return f"{stem}-{suffix}.{ext}"


ParticipantIds = Annotated[list[str] | None, Query()]


@router.get("/studies/{study_id}/exports", response_model=list[ExportInfo])
async def list_exports(
    study_id: int,
    participant_ids: ParticipantIds = None,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> list[ExportInfo]:
    """Every export this study can produce, with how many rows it holds.

    A download that turns out to be a header and nothing else is impossible to
    tell from a broken one, and the calibration export is exactly that on any
    study run since the tracker started being calibrated outside the app.
    With `participant_ids` the counts are for those people only.
    """
    await _study_or_404(db, study_id)
    chosen = await _chosen_participants(db, study_id, participant_ids)
    in_app_calibration = get_settings().CALIBRATION_ENABLED

    infos = []
    for kind, (filename, _header, build, _shape) in _EXPORTS.items():
        rows = await db.scalar(
            # Ordering a row count is work Postgres would do and then throw away.
            select(func.count()).select_from(build(study_id, chosen).order_by(None).subquery())
        )
        infos.append(
            ExportInfo(
                kind=kind,
                filename=_filename(kind, filename, chosen),
                rows=rows or 0,
                collected=in_app_calibration if kind == "calibration" else True,
            )
        )
    samples = await db.scalar(
        _only(
            select(func.sum(GazeRecording.sample_count))
            .join(Participant, Participant.id == GazeRecording.participant_id)
            .where(Participant.study_id == study_id),
            GazeRecording.participant_id,
            chosen,
        )
    )
    infos.append(
        ExportInfo(
            kind="gaze",
            filename=_filename("gaze", "gaze.csv", chosen),
            rows=samples or 0,
            collected=True,
        )
    )
    return infos


@router.get("/studies/{study_id}/export/{kind}")
async def export_csv(
    study_id: int,
    kind: str,
    participant_ids: ParticipantIds = None,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    await _study_or_404(db, study_id)

    export = _EXPORTS.get(kind)
    if export is None and kind != "gaze":
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown export: {kind!r}")

    chosen = await _chosen_participants(db, study_id, participant_ids)
    if kind == "gaze":
        return await _raw_gaze_export(db, study_id, chosen)
    assert export is not None
    filename, header, build, shape = export
    return _csv_stream(
        db, _filename(kind, filename, chosen), header, build(study_id, chosen), shape
    )


async def _raw_gaze_export(
    db: AsyncSession, study_id: int, chosen: list[str] | None
) -> StreamingResponse:
    stmt = _only(
        select(GazeRecording)
        .join(Participant, Participant.id == GazeRecording.participant_id)
        .where(Participant.study_id == study_id)
        .order_by(GazeRecording.participant_id, GazeRecording.started_at, GazeRecording.id),
        GazeRecording.participant_id,
        chosen,
    )
    stmt = _with_case(stmt, GazeRecording.participant_id, GazeRecording.video_id, study_id)
    # Geometry can be substantial: hold only one recording at a time. Checking
    # file presence first catches common failures before HTTP headers are sent.
    result = await db.stream(stmt.execution_options(yield_per=1))
    try:
        async for row in result:
            await run_in_threadpool(check_storage, row[0], get_settings())
    except GazeStorageError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    finally:
        await result.close()

    async def rows():
        header = io.StringIO()
        csv.writer(header).writerow(GAZE_COLUMNS)
        yield b"\xef\xbb\xbf" + header.getvalue().encode("utf-8")
        result = await db.stream(stmt.execution_options(yield_per=1))
        try:
            async for row in result:
                # Errors abort the stream; the browser must never save an
                # apparently successful CSV with missing or corrupt samples.
                batches = csv_batches(row[0], get_settings(), _case_cells(row), _defuse)
                try:
                    async for chunk in iterate_in_threadpool(batches):
                        yield chunk
                finally:
                    await run_in_threadpool(batches.close)
        finally:
            await result.close()

    filename = _filename("gaze", "gaze.csv", chosen)
    return StreamingResponse(
        rows(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _iso(value) -> str:
    return value.isoformat() if value else ""


# The columns every per-case file carries right after `video_id`.
CASE_COLUMNS = ("case_number", "phase_type", "video_title")


def _default_positions(study_id: int):
    """video_id -> 1-based position in the study's default order.

    A participant with no sequence of their own meets the study's videos in
    phase order, then upload order (`session_script.default_order`). The same
    ranking is written here in SQL so that such a run is numbered the way the
    script numbered it; a test pins the two together.
    """
    rank = case(
        (Video.phase_type == PhaseType.pre_test, 0),
        (Video.phase_type == PhaseType.training, 1),
        (Video.phase_type == PhaseType.post_test, 2),
        else_=9,
    )
    return (
        select(
            Video.id.label("video_id"),
            func.row_number().over(order_by=(rank, Video.id)).label("position"),
        )
        .where(Video.study_id == study_id)
        .subquery()
    )


def _with_case(stmt, participant_col, video_col, study_id: int):
    """Append the columns that say which case a row belongs to.

    `video_id` alone is a database number the researchers never chose, and it
    says nothing about *when* in the run the case came: the two video sets show
    the training clips in opposite orders, so clip 8 is one person's second
    case and another's eighth. The position comes from the sequence copied onto
    the participant — the order they actually met the cases in, whichever set
    was dealt or whatever was hand-picked. A run with no sequence at all is on
    the study's default order and is numbered like that. Rows with no case, a
    login or a pre-test page, leave all three empty.

    The four columns land at the end of the row, where `_case_cells` reads them.
    """
    slot = aliased(ParticipantVideo)
    any_slot = aliased(ParticipantVideo)
    positions = _default_positions(study_id)
    has_sequence = exists().where(any_slot.participant_id == participant_col)
    position = case(
        (slot.slot_index.is_not(None), slot.slot_index + 1),
        (and_(video_col.is_not(None), ~has_sequence), positions.c.position),
        else_=None,
    )
    return (
        stmt.add_columns(
            position.label("case_number"),
            slot.phase_type.label("slot_phase"),
            Video.phase_type.label("video_phase"),
            Video.title.label("video_title"),
        )
        .outerjoin(slot, and_(slot.participant_id == participant_col, slot.video_id == video_col))
        .outerjoin(Video, Video.id == video_col)
        .outerjoin(positions, positions.c.video_id == video_col)
    )


def _case_cells(r) -> list:
    """The case columns as the file shows them, read from where `_with_case` put them."""
    position, slot_phase, video_phase, title = r[-4:]
    # The slot's phase is the one the participant was shown; the clip's own is
    # the fallback for a run on the default order.
    phase = slot_phase or video_phase
    return [position, phase.value if phase else "", title or ""]


def _participants_query(study_id: int, participant_ids: list[str] | None = None):
    # The set is the condition every other table is analysed against, the
    # sequence is the order the cases were actually met in, and the batch size
    # says whether a think-aloud followed its case or a block of them — none of
    # it is on any other row.
    stmt = (
        select(
            Participant.id,
            Participant.status,
            Participant.video_set_id,
            VideoSet.name,
            func.array_agg(
                aggregate_order_by(ParticipantVideo.video_id, ParticipantVideo.slot_index)
            ).filter(ParticipantVideo.id.is_not(None)),
            Participant.think_aloud_batch_size,
            Participant.created_at,
        )
        .outerjoin(VideoSet, VideoSet.id == Participant.video_set_id)
        .outerjoin(ParticipantVideo, ParticipantVideo.participant_id == Participant.id)
        .where(Participant.study_id == study_id)
        .group_by(Participant.id, VideoSet.name)
        .order_by(Participant.id)
    )
    return _only(stmt, Participant.id, participant_ids)


def _notes_query(study_id: int, participant_ids: list[str] | None = None):
    stmt = (
        select(
            Note.participant_id, Note.video_id, Note.video_time_seconds, Note.text, Note.created_at
        )
        .join(Participant, Participant.id == Note.participant_id)
        .where(Participant.study_id == study_id)
        .order_by(Note.participant_id, Note.id)
    )
    stmt = _only(stmt, Note.participant_id, participant_ids)
    return _with_case(stmt, Note.participant_id, Note.video_id, study_id)


def _diagnoses_query(study_id: int, participant_ids: list[str] | None = None):
    stmt = (
        select(
            TextEntry.participant_id,
            TextEntry.video_id,
            TextEntry.text,
            TextEntry.time_spent_seconds,
            TextEntry.created_at,
        )
        .join(Participant, Participant.id == TextEntry.participant_id)
        .where(Participant.study_id == study_id, TextEntry.kind == "diagnosis")
        .order_by(TextEntry.participant_id, TextEntry.id)
    )
    stmt = _only(stmt, TextEntry.participant_id, participant_ids)
    return _with_case(stmt, TextEntry.participant_id, TextEntry.video_id, study_id)


def _responses_query(study_id: int, participant_ids: list[str] | None = None):
    # Placement travels with the row: without it a pre-test page and a case
    # battery are told apart only by an empty video_id, which is a guess.
    stmt = (
        select(
            QuestionnaireResponse.participant_id,
            QuestionnaireResponse.questionnaire_id,
            Questionnaire.placement,
            Questionnaire.title,
            Questionnaire.section,
            QuestionnaireResponse.video_id,
            QuestionnaireResponse.answers,
            QuestionnaireResponse.time_spent_seconds,
            QuestionnaireResponse.created_at,
            Questionnaire.section_key,
            QuestionnaireResponse.response_status,
        )
        .join(Participant, Participant.id == QuestionnaireResponse.participant_id)
        .join(Questionnaire, Questionnaire.id == QuestionnaireResponse.questionnaire_id)
        .where(Participant.study_id == study_id)
        .order_by(QuestionnaireResponse.participant_id, QuestionnaireResponse.id)
    )
    stmt = _only(stmt, QuestionnaireResponse.participant_id, participant_ids)
    return _with_case(
        stmt, QuestionnaireResponse.participant_id, QuestionnaireResponse.video_id, study_id
    )


def _sections_query(study_id: int, participant_ids: list[str] | None = None):
    # Keep the original response-duration totals; actual timed attempts are separate.
    section = func.coalesce(func.nullif(Questionnaire.section, ""), Questionnaire.title)
    section_group = case(
        (Questionnaire.section_key != "", Questionnaire.section_key), else_=section
    )
    is_pre_test = Questionnaire.placement == QuestionnairePlacement.pre_test
    seconds = QuestionnaireResponse.time_spent_seconds
    totals = _only(
        select(
            QuestionnaireResponse.participant_id.label("participant_id"),
            func.min(section).label("section"),
            func.bool_and(is_pre_test).label("pre_test"),
            func.count()
            .filter(QuestionnaireResponse.response_status == "submitted")
            .label("pages_answered"),
            func.sum(seconds).label("time_spent_seconds"),
            func.sum(func.sum(seconds).filter(is_pre_test))
            .over(partition_by=QuestionnaireResponse.participant_id)
            .label("pre_test_total_seconds"),
            Questionnaire.section_key.label("section_key"),
            func.min(QuestionnaireResponse.id).label("first_response"),
        )
        .join(Participant, Participant.id == QuestionnaireResponse.participant_id)
        .join(Questionnaire, Questionnaire.id == QuestionnaireResponse.questionnaire_id)
        .where(Participant.study_id == study_id)
        .group_by(QuestionnaireResponse.participant_id, section_group, Questionnaire.section_key),
        QuestionnaireResponse.participant_id,
        participant_ids,
    ).subquery()
    attempts = _only(
        select(SectionAttempt)
        .join(Participant, Participant.id == SectionAttempt.participant_id)
        .where(Participant.study_id == study_id),
        SectionAttempt.participant_id,
        participant_ids,
    ).subquery()
    visit_groups = _only(
        select(
            QuestionnaireVisit.participant_id.label("participant_id"),
            QuestionnaireVisit.section_key.label("section_key"),
            func.min(section).label("section"),
        )
        .join(Participant, Participant.id == QuestionnaireVisit.participant_id)
        .join(Questionnaire, Questionnaire.id == QuestionnaireVisit.questionnaire_id)
        .where(Participant.study_id == study_id)
        .group_by(QuestionnaireVisit.participant_id, QuestionnaireVisit.section_key),
        QuestionnaireVisit.participant_id,
        participant_ids,
    ).subquery()
    pid = func.coalesce(
        totals.c.participant_id, attempts.c.participant_id, visit_groups.c.participant_id
    )
    key = func.coalesce(totals.c.section_key, attempts.c.section_key, visit_groups.c.section_key)
    visits = (
        select(
            func.jsonb_agg(
                aggregate_order_by(
                    func.jsonb_build_object(
                        "visit_id",
                        QuestionnaireVisit.id,
                        "questionnaire_id",
                        QuestionnaireVisit.questionnaire_id,
                        "step_index",
                        QuestionnaireVisit.step_index,
                        "entered_client_ts",
                        QuestionnaireVisit.entered_client_ts,
                        "exited_client_ts",
                        QuestionnaireVisit.exited_client_ts,
                        "exit_reason",
                        QuestionnaireVisit.exit_reason,
                        "is_review",
                        QuestionnaireVisit.is_review,
                        "submitted_answers",
                        QuestionnaireVisit.submitted_answers,
                    ),
                    QuestionnaireVisit.entered_client_ts,
                    QuestionnaireVisit.id,
                )
            )
        )
        .where(
            QuestionnaireVisit.participant_id == pid,
            QuestionnaireVisit.section_key == key,
        )
        .correlate(totals, attempts, visit_groups)
        .scalar_subquery()
    )
    visited_pages = (
        select(func.count(func.distinct(QuestionnaireVisit.questionnaire_id)))
        .where(
            QuestionnaireVisit.participant_id == pid,
            QuestionnaireVisit.section_key == key,
            QuestionnaireVisit.is_review.is_(False),
        )
        .correlate(totals, attempts, visit_groups)
        .scalar_subquery()
    )
    visit_seconds = (
        select(
            func.sum(QuestionnaireVisit.exited_client_ts - QuestionnaireVisit.entered_client_ts)
            / 1000.0
        )
        .where(
            QuestionnaireVisit.participant_id == pid,
            QuestionnaireVisit.section_key == key,
            QuestionnaireVisit.is_review.is_(False),
        )
        .correlate(totals, attempts, visit_groups)
        .scalar_subquery()
    )
    elapsed = (attempts.c.ended_client_ts - attempts.c.started_client_ts) / 1000.0
    return (
        select(
            pid.label("participant_id"),
            func.coalesce(totals.c.section, attempts.c.section, visit_groups.c.section).label(
                "section"
            ),
            func.coalesce(totals.c.pre_test, True),
            func.coalesce(totals.c.pages_answered, 0),
            totals.c.time_spent_seconds,
            totals.c.pre_test_total_seconds,
            key,
            attempts.c.started_client_ts,
            attempts.c.ended_client_ts,
            elapsed,
            attempts.c.deadline_ms,
            case((attempts.c.ended_client_ts.is_not(None), func.greatest(elapsed - 420, 0))),
            attempts.c.exit_reason,
            case((key != "", visited_pages)),
            visit_seconds,
            visits,
        )
        .select_from(
            totals.join(
                attempts,
                and_(
                    totals.c.participant_id == attempts.c.participant_id,
                    totals.c.section_key == attempts.c.section_key,
                ),
                full=True,
            ).join(
                visit_groups,
                and_(
                    func.coalesce(totals.c.participant_id, attempts.c.participant_id)
                    == visit_groups.c.participant_id,
                    func.coalesce(totals.c.section_key, attempts.c.section_key)
                    == visit_groups.c.section_key,
                ),
                full=True,
            )
        )
        .order_by(pid, totals.c.first_response.nulls_last(), key)
    )


def _events_query(study_id: int, participant_ids: list[str] | None = None):
    stmt = (
        select(
            InteractionLog.participant_id,
            InteractionLog.event_type,
            InteractionLog.video_id,
            InteractionLog.payload,
            InteractionLog.client_ts,
            InteractionLog.created_at,
        )
        .join(Participant, Participant.id == InteractionLog.participant_id)
        .where(Participant.study_id == study_id)
        .order_by(InteractionLog.id)
    )
    stmt = _only(stmt, InteractionLog.participant_id, participant_ids)
    return _with_case(stmt, InteractionLog.participant_id, InteractionLog.video_id, study_id)


def _videos_query(study_id: int, participant_ids: list[str] | None = None):
    # The key every other export's `video_id` points at. Without it a researcher
    # holding notes.csv has no way to say which case a row belongs to. Not per
    # participant, so the filter does not apply.
    return (
        select(
            Video.id,
            Video.title,
            Video.phase_type,
            Video.time_limit_seconds,
            Video.duration_seconds,
            Video.created_at,
        )
        .where(Video.study_id == study_id)
        .order_by(Video.id)
    )


def _gaze_query(study_id: int, participant_ids: list[str] | None = None):
    stmt = (
        select(
            GazeRecording.participant_id,
            GazeRecording.video_id,
            GazeRecording.sampling_rate_hz,
            GazeRecording.sample_count,
            GazeRecording.started_at,
            GazeRecording.completed_at,
            GazeRecording.id,
            GazeRecording.step_kind,
            GazeRecording.step_index,
            GazeRecording.questionnaire_id,
        )
        .join(Participant, Participant.id == GazeRecording.participant_id)
        .where(Participant.study_id == study_id)
        .order_by(GazeRecording.participant_id, GazeRecording.id)
    )
    stmt = _only(stmt, GazeRecording.participant_id, participant_ids)
    return _with_case(stmt, GazeRecording.participant_id, GazeRecording.video_id, study_id)


def _calibration_query(study_id: int, participant_ids: list[str] | None = None):
    stmt = (
        select(
            GazeCalibration.participant_id,
            GazeCalibration.status,
            GazeCalibration.mean_offset,
            GazeCalibration.mean_offset_degrees,
            GazeCalibration.created_at,
        )
        .join(Participant, Participant.id == GazeCalibration.participant_id)
        .where(Participant.study_id == study_id)
        .order_by(GazeCalibration.participant_id, GazeCalibration.id)
    )
    return _only(stmt, GazeCalibration.participant_id, participant_ids)


# name -> (filename, header, query builder, row shaper)
_EXPORTS = {
    "participants": (
        "participants.csv",
        [
            "participant_id",
            "status",
            "video_set_id",
            "video_set",
            "sequence",
            "think_aloud_batch_size",
            "created_at",
        ],
        _participants_query,
        lambda r: [r[0], r[1].value, r[2], r[3], json.dumps(list(r[4] or [])), r[5], _iso(r[6])],
    ),
    "videos": (
        "videos.csv",
        [
            "video_id",
            "title",
            "phase_type",
            "time_limit_seconds",
            "time_limit",
            "duration_seconds",
            "duration",
            "created_at",
        ],
        _videos_query,
        lambda r: [
            r[0],
            r[1],
            r[2].value,
            r[3],
            timecode(r[3]),
            r[4],
            timecode(r[4]),
            _iso(r[5]),
        ],
    ),
    "notes": (
        "notes.csv",
        [
            "participant_id",
            "video_id",
            *CASE_COLUMNS,
            "video_time_seconds",
            "video_time",
            "text",
            "created_at",
        ],
        _notes_query,
        lambda r: [r[0], r[1], *_case_cells(r), r[2], timecode(r[2]), r[3], _iso(r[4])],
    ),
    "diagnoses": (
        "diagnoses.csv",
        ["participant_id", "video_id", *CASE_COLUMNS, "text", "time_spent_seconds", "created_at"],
        _diagnoses_query,
        lambda r: [r[0], r[1], *_case_cells(r), r[2], r[3], _iso(r[4])],
    ),
    "responses": (
        "responses.csv",
        [
            "participant_id",
            "questionnaire_id",
            "placement",
            "questionnaire_title",
            "section",
            "video_id",
            *CASE_COLUMNS,
            "answers",
            "time_spent_seconds",
            "created_at",
            "section_key",
            "response_status",
        ],
        _responses_query,
        lambda r: [
            r[0],
            r[1],
            r[2].value,
            r[3],
            r[4],
            r[5],
            *_case_cells(r),
            json.dumps(r[6]),
            r[7],
            _iso(r[8]),
            r[9],
            r[10],
        ],
    ),
    "sections": (
        "sections.csv",
        [
            "participant_id",
            "section",
            "pre_test",
            "pages_answered",
            "time_spent_seconds",
            "pre_test_total_seconds",
            "section_key",
            "started_client_ts",
            "ended_client_ts",
            "elapsed_seconds",
            "deadline_ms",
            "deadline_overrun_seconds",
            "exit_reason",
            "visited_pages",
            "visit_seconds",
            "page_visits",
        ],
        _sections_query,
        lambda r: [
            r[0],
            r[1],
            "true" if r[2] else "false",
            *r[3:15],
            json.dumps(r[15]) if r[15] is not None else "",
        ],
    ),
    "events": (
        "events.csv",
        [
            "participant_id",
            "event_type",
            "variable_name",
            "video_id",
            *CASE_COLUMNS,
            # Where the clip stood when this happened, and — for a seek — where
            # it was dragged from. `payload` keeps the raw seconds.
            "video_time",
            "video_time_from",
            # Which screen a `progress_update` finished; empty on every other row.
            "completed_step",
            "payload",
            "client_ts",
            "created_at",
        ],
        _events_query,
        lambda r: [
            r[0],
            r[1],
            variable_name(r[1]),
            r[2],
            *_case_cells(r),
            timecode(playhead_seconds(r[3])),
            timecode(seek_origin_seconds(r[3])),
            completed_step_label(r[3]),
            json.dumps(r[3]),
            r[4],
            _iso(r[5]),
        ],
    ),
    "gaze_recordings": (
        "gaze_recordings.csv",
        [
            "participant_id",
            "video_id",
            *CASE_COLUMNS,
            "sampling_rate_hz",
            "sample_count",
            "started_at",
            "completed_at",
            "recording_id",
            "step_kind",
            "step_index",
            "questionnaire_id",
        ],
        _gaze_query,
        lambda r: [r[0], r[1], *_case_cells(r), r[2], r[3], _iso(r[4]), _iso(r[5]), *r[6:10]],
    ),
    "calibration": (
        "calibration.csv",
        ["participant_id", "status", "mean_offset", "mean_offset_degrees", "created_at"],
        _calibration_query,
        lambda r: [r[0], r[1], r[2], r[3], _iso(r[4])],
    ),
}
