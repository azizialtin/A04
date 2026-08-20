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
