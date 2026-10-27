from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class ParticipantMeResponse(BaseModel):
    id: str
    study_name: str
    status: str


class SectionTimingResponse(BaseModel):
    section_key: str
    deadline_ms: int
    server_now_ms: int
    finished: bool
    started_client_ts: int
    ended_client_ts: int | None = None


class SessionScriptResponse(BaseModel):
    status: str
    current_step_index: int
    total_steps: int
    steps: list[dict]
    section_timing: SectionTimingResponse | None = None


class ProgressUpdateRequest(BaseModel):
    current_step_index: int = Field(ge=0)
    client_ts: int | None = Field(default=None, ge=0)
    expected_step_index: int | None = Field(default=None, ge=0)


class QuestionnaireVisitRequest(BaseModel):
    step_index: int = Field(ge=0)
    questionnaire_id: int
    visit_id: UUID
    client_ts: int = Field(ge=0)


class QuestionnaireVisitResponse(BaseModel):
    visit_id: str
    section_timing: SectionTimingResponse | None = None


class FinishCkRequest(BaseModel):
    expected_step_index: int = Field(ge=0)
    visit_id: UUID
    request_id: UUID
    client_ts: int = Field(ge=0)
    answers: dict[str, Any] = Field(default_factory=dict)


class StepBackRequest(BaseModel):
    visit_id: UUID | None = None
    client_ts: int | None = Field(default=None, ge=0)


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
    visit_id: UUID | None = None
    client_ts: int | None = Field(default=None, ge=0)
    advance: bool = False


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
