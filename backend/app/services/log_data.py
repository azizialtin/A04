"""What the case screen logs, tied back to the study's data dictionary.

The frontend fires events named for what happened; the analysis plan (sheet
"Log Data Collection on Main Screen" in `A04_DataCollection.xlsx`) names the
same things differently. Rather than rename the events — the gaze replay reads
them, and they are already in recorded runs — the export carries both, and this
table is the join between them.

Anything not listed here exports with an empty variable name: it is ours (a
progress tick, a client error), not part of the main-screen log.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

MAIN_SCREEN_VARIABLES: dict[str, str] = {
    "case_screen_entered": "enter_main_screen",
    "case_screen_exited": "exit_main_screen",
    "video_started": "click_event_play",
    "video_resumed": "click_event_play",
    # `video_replayed` is deliberately absent: the player fires it *alongside*
    # `video_resumed` for the same press, and one click has to be one row.
    "video_paused": "click_event_pause",
    # Spelled as the sheet spells it, typo and all — it is the key an analysis
    # joins the export to the codebook on.
    "video_seeked": "set_video_playhad_to",
    "notes_focused": "click_event_notes_field",
    "notes_typed": "type_in_notes_field",
    "info_opened": "click_event_info_button",
    "info_closed": "click_event_close_info_pop_up",
    "student_task_opened": "click_event_student_task_button",
    "student_task_closed": "click_event_close_student_task_pop_up",
}


def variable_name(event_type: str) -> str:
    return MAIN_SCREEN_VARIABLES.get(event_type, "")


# Where the playhead stood when an event fired. The player stamps every playback
# event with `currentTime`; a note carries the same thing under the name the
# notes API uses.
_PLAYHEAD_KEYS = ("currentTime", "video_time_seconds")


def _number(value: object) -> float | None:
    # Payloads are JSONB written by the browser: anything in them is a guess
    # until it has been looked at. bool is an int in Python and never a time.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def playhead_seconds(payload: Mapping[str, Any] | None) -> float | None:
    for key in _PLAYHEAD_KEYS:
        seconds = _number((payload or {}).get(key))
        if seconds is not None:
            return seconds
    return None


def seek_origin_seconds(payload: Mapping[str, Any] | None) -> float | None:
    """Where a seek started. Only `video_seeked` has one."""
    return _number((payload or {}).get("from"))


def step_label(step: Mapping[str, Any] | None) -> str:
    """A step of the session script named for a human reading the export.

    Reads the descriptor `session_script.describe_step` writes into a
    `progress_update` payload — `questionnaire: Angaben zur Person (page 1/2)`,
    `case_video: Fall 3` — and is empty for a run recorded before that existed.
    """
    if not isinstance(step, Mapping):
        return ""
    kind = str(step.get("kind") or "")
    if not kind:
        return ""

    name = step.get("title") or step.get("variant") or step.get("phase_type") or ""
    label = f"{kind}: {name}" if name else kind

    page, page_count = step.get("page"), step.get("page_count")
    if isinstance(page, int) and isinstance(page_count, int) and page_count > 1:
        label += f" (page {page}/{page_count})"
    return label


def completed_step_label(payload: Mapping[str, Any] | None) -> str:
    """The screen a `progress_update` says the participant just finished."""
    return step_label((payload or {}).get("completed_step"))
