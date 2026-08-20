from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field


class StudyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    sosci_pretest_url: str = ""
    sosci_posttest_url: str = ""
    sosci_id_param: str = "id"


class StudyUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    sosci_pretest_url: str | None = None
    sosci_posttest_url: str | None = None
    sosci_id_param: str | None = None
    is_active: bool | None = None


class StudyResponse(BaseModel):
    id: int
    name: str
    description: str
    sosci_pretest_url: str
    sosci_posttest_url: str
    sosci_id_param: str
    is_active: bool


class VideoUpdate(BaseModel):
    title: str | None = None
    phase_type: str | None = None
    task_description: str | None = None
    info_text: str | None = None
    student_task_text: str | None = None
    time_limit_seconds: int | None = None


class VideoResponse(BaseModel):
    id: int
    study_id: int
    title: str
    phase_type: str
    task_description: str
    info_text: str
    student_task_text: str
    time_limit_seconds: int | None
    has_file: bool


class ParticipantsCreate(BaseModel):
    # Generous per-item cap so the endpoint can report over-long ids itself,
    # with a useful message, rather than pydantic rejecting the request wholesale.
    ids: list[Annotated[str, Field(max_length=256)]] = Field(min_length=1, max_length=1000)


class SequenceItem(BaseModel):
    video_id: int
    slot_index: int = Field(ge=0)
    phase_type: str


class SequenceAssign(BaseModel):
    items: list[SequenceItem]


class BulkAssign(BaseModel):
    participant_ids: list[str] = Field(min_length=1)
    items: list[SequenceItem]


class ParticipantResponse(BaseModel):
    id: str
    status: str
    slot_count: int


class ParticipantDetail(BaseModel):
    id: str
    status: str
    current_step_index: int | None
    sequence: list[dict]


class QuestionnaireCreate(BaseModel):
    placement: str
    title: str = Field(min_length=1, max_length=255)
    description: str = ""
    order_index: int = 0
    questions: list[dict] = Field(default_factory=list)


class QuestionnaireUpdate(BaseModel):
    placement: str | None = None
    title: str | None = None
    description: str | None = None
    order_index: int | None = None
    questions: list[dict] | None = None


class QuestionnaireOut(BaseModel):
    id: int
    study_id: int
    placement: str
    title: str
    description: str
    order_index: int
    questions: list[dict]
