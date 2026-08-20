"""CSV exports — the raw data as the researchers take it away.

Streamed from a server-side cursor: the interaction log is unbounded, and
building a study's worth of it in memory before sending a byte is how an
export falls over just when it matters.
"""

from __future__ import annotations

import csv
import io
import json

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.researcher import Researcher
from app.models.text_entry import TextEntry
from app.services.log_data import variable_name

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


@router.get("/studies/{study_id}/export/{kind}")
async def export_csv(
    study_id: int,
    kind: str,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    await _study_or_404(db, study_id)

    export = _EXPORTS.get(kind)
    if export is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown export: {kind!r}")

    filename, header, build, shape = export
    return _csv_stream(db, filename, header, build(study_id), shape)


def _iso(value) -> str:
    return value.isoformat() if value else ""


def _notes_query(study_id: int):
    return (
        select(
            Note.participant_id, Note.video_id, Note.video_time_seconds, Note.text, Note.created_at
        )
        .join(Participant, Participant.id == Note.participant_id)
        .where(Participant.study_id == study_id)
        .order_by(Note.participant_id, Note.id)
    )


def _diagnoses_query(study_id: int):
    return (
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


def _responses_query(study_id: int):
    # Placement travels with the row: without it a pre-test page and a case
    # battery are told apart only by an empty video_id, which is a guess.
    return (
        select(
            QuestionnaireResponse.participant_id,
            QuestionnaireResponse.questionnaire_id,
            Questionnaire.placement,
            Questionnaire.title,
            QuestionnaireResponse.video_id,
            QuestionnaireResponse.answers,
            QuestionnaireResponse.time_spent_seconds,
            QuestionnaireResponse.created_at,
        )
        .join(Participant, Participant.id == QuestionnaireResponse.participant_id)
        .join(Questionnaire, Questionnaire.id == QuestionnaireResponse.questionnaire_id)
        .where(Participant.study_id == study_id)
        .order_by(QuestionnaireResponse.participant_id, QuestionnaireResponse.id)
    )


def _events_query(study_id: int):
    return (
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


def _gaze_query(study_id: int):
    return (
        select(
            GazeRecording.participant_id,
            GazeRecording.video_id,
            GazeRecording.sampling_rate_hz,
            GazeRecording.sample_count,
            GazeRecording.started_at,
            GazeRecording.completed_at,
        )
        .join(Participant, Participant.id == GazeRecording.participant_id)
        .where(Participant.study_id == study_id)
        .order_by(GazeRecording.participant_id, GazeRecording.id)
    )


def _calibration_query(study_id: int):
    return (
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


# name -> (filename, header, query builder, row shaper)
_EXPORTS = {
    "notes": (
        "notes.csv",
        ["participant_id", "video_id", "video_time_seconds", "text", "created_at"],
        _notes_query,
        lambda r: [r[0], r[1], r[2], r[3], _iso(r[4])],
    ),
    "diagnoses": (
        "diagnoses.csv",
        ["participant_id", "video_id", "text", "time_spent_seconds", "created_at"],
        _diagnoses_query,
        lambda r: [r[0], r[1], r[2], r[3], _iso(r[4])],
    ),
    "responses": (
        "responses.csv",
        [
            "participant_id",
            "questionnaire_id",
            "placement",
            "questionnaire_title",
            "video_id",
            "answers",
            "time_spent_seconds",
            "created_at",
        ],
        _responses_query,
        lambda r: [r[0], r[1], r[2].value, r[3], r[4], json.dumps(r[5]), r[6], _iso(r[7])],
    ),
    "events": (
        "events.csv",
        [
            "participant_id",
            "event_type",
            "variable_name",
            "video_id",
            "payload",
            "client_ts",
            "created_at",
        ],
        _events_query,
        lambda r: [r[0], r[1], variable_name(r[1]), r[2], json.dumps(r[3]), r[4], _iso(r[5])],
    ),
    "gaze": (
        "gaze.csv",
        [
            "participant_id",
            "video_id",
            "sampling_rate_hz",
            "sample_count",
            "started_at",
            "completed_at",
        ],
        _gaze_query,
        lambda r: [r[0], r[1], r[2], r[3], _iso(r[4]), _iso(r[5])],
    ),
    "calibration": (
        "calibration.csv",
        ["participant_id", "status", "mean_offset", "mean_offset_degrees", "created_at"],
        _calibration_query,
        lambda r: [r[0], r[1], r[2], r[3], _iso(r[4])],
    ),
}
