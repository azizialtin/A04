from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ParticipantMeResponse(BaseModel):
    id: str
    study_name: str
    status: str


class SessionScriptResponse(BaseModel):
    status: str
    current_step_index: int
    total_steps: int
    steps: list[dict]


class ProgressUpdateRequest(BaseModel):
    current_step_index: int = Field(ge=0)


class ProgressResult(BaseModel):
    status: str
    current_step_index: int
    total_steps: int
    complete: bool


class VideoUrlResponse(BaseModel):
    signed_url: str


class NoteCreate(BaseModel):
    video_id: int
    video_time_seconds: float = Field(ge=0)
    # Browser wall clock. The playhead places a note in the clip; only this can
    # place it in a screen recording, which runs on wall time.
    client_ts: int | None = None
    text: str


class DiagnosisCreate(BaseModel):
    video_id: int
    text: str = Field(min_length=1)
    time_spent_seconds: int | None = None
    # The rating questions shown under the write-up (confidence, and whatever
    # else the study adds). They are stored in the same transaction as the text.
    answers: dict[str, Any] = Field(default_factory=dict)


class QuestionnaireRespondRequest(BaseModel):
    # Null for the pre-test pages: they are answered once, for the whole run.
    video_id: int | None = None
    answers: dict[str, Any] = Field(default_factory=dict)
    time_spent_seconds: int | None = None


class EventCreate(BaseModel):
    event_type: str = Field(min_length=1, max_length=64)
    video_id: int | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    # Epoch ms from the browser; the gaze replay needs it (see InteractionLog).
    client_ts: int | None = None


class IdResponse(BaseModel):
    id: int


class NoteResponse(BaseModel):
    video_time_seconds: float
    client_ts: int | None = None
    text: str
    created_at: str
