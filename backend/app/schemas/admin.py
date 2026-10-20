from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field


class StudyTexts(BaseModel):
    """Participant-facing wording the researcher may change: the welcome page
    and the short page before each case. Empty means the app's default; the
    researcher writes in the language of the study, and the override shows in
    both interface languages."""

    welcome_title: str = Field(default="", max_length=200)
    welcome_intro: str = Field(default="", max_length=4000)
    # One line per step of the sitting, in the order they come.
    welcome_steps: list[Annotated[str, Field(max_length=500)]] = Field(
        default_factory=list, max_length=12
    )
    welcome_note: str = Field(default="", max_length=1000)
    case_intro_title: str = Field(default="", max_length=200)
    case_intro_body: str = Field(default="", max_length=4000)
    # The screen that closes a case, and the think-aloud: heading and text.
    case_outro_title: str = Field(default="", max_length=200)
    case_outro_body: str = Field(default="", max_length=4000)
    think_aloud_title: str = Field(default="", max_length=200)
    think_aloud_body: str = Field(default="", max_length=4000)


class StudyVideoDefaults(BaseModel):
    """What a new video is filled with. The timer is copied into the video
    when it is uploaded; the two texts stay the study's, and a video that opts
    in follows them — change the default once and every such video changes."""

    time_limit_seconds: int | None = Field(default=None, ge=0, le=36_000)
    task_description: str = Field(default="", max_length=4000)
    info_text: str = Field(default="", max_length=8000)


# One think-aloud per case is the shape the study was designed around; a bigger
# block is a deliberate choice, and beyond a couple of dozen it is a typo.
MAX_THINK_ALOUD_BATCH = 20


class StudyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    sosci_pretest_url: str = ""
    sosci_posttest_url: str = ""
    sosci_id_param: str = "id"
    think_aloud_batch_size: int = Field(default=1, ge=1, le=MAX_THINK_ALOUD_BATCH)


class StudyUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    sosci_pretest_url: str | None = None
    sosci_posttest_url: str | None = None
    sosci_id_param: str | None = None
    is_active: bool | None = None
    texts: StudyTexts | None = None
    video_defaults: StudyVideoDefaults | None = None
    think_aloud_batch_size: int | None = Field(default=None, ge=1, le=MAX_THINK_ALOUD_BATCH)


class StudyResponse(BaseModel):
    id: int
    name: str
    description: str
    sosci_pretest_url: str
    sosci_posttest_url: str
    sosci_id_param: str
    is_active: bool
    texts: StudyTexts
    video_defaults: StudyVideoDefaults
    # Training cases worked through before their think-aloud screens play.
    think_aloud_batch_size: int


class VideoUpdate(BaseModel):
    title: str | None = None
    phase_type: str | None = None
    task_description: str | None = None
    info_text: str | None = None
    student_task_text: str | None = None
    time_limit_seconds: int | None = None
    use_default_task: bool | None = None
    use_default_info: bool | None = None


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
    # True: the participant sees the study's default text, not this video's own.
    use_default_task: bool = False
    use_default_info: bool = False


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
    # The set they were dealt at first login (or given by hand); None before
    # that, or when the researcher hand-picked their sequence instead.
    video_set_id: int | None = None
    video_set_name: str | None = None


class ParticipantDetail(BaseModel):
    id: str
    status: str
    current_step_index: int | None
    sequence: list[dict]
    video_set_id: int | None = None
    video_set_name: str | None = None
    # Pinned when the run opened; null until then, when the study's value applies.
    think_aloud_batch_size: int | None = None


class VideoSetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    items: list[SequenceItem] = Field(default_factory=list)


class VideoSetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    items: list[SequenceItem] | None = None


class VideoSetItemOut(BaseModel):
    slot_index: int
    video_id: int
    video_title: str
    phase_type: str


class VideoSetOut(BaseModel):
    id: int
    study_id: int
    name: str
    items: list[VideoSetItemOut]
    # How many participants have been dealt this set so far — the number the
    # balancing keeps level.
    participant_count: int


class VideoSetAssign(BaseModel):
    video_set_id: int


class QuestionnaireCreate(BaseModel):
    placement: str
    title: str = Field(min_length=1, max_length=255)
    description: str = ""
    # The instrument the page belongs to; pages sharing one are added up
    # together in the timing statistics.
    section: str = Field(default="", max_length=64)
    order_index: int = 0
    questions: list[dict] = Field(default_factory=list)


class QuestionnaireUpdate(BaseModel):
    placement: str | None = None
    title: str | None = None
    description: str | None = None
    section: str | None = Field(default=None, max_length=64)
    order_index: int | None = None
    questions: list[dict] | None = None


class QuestionnaireOut(BaseModel):
    id: int
    study_id: int
    placement: str
    title: str
    description: str
    section: str
    order_index: int
    questions: list[dict]


class ExportInfo(BaseModel):
    """One CSV on the exports tab, and whether there is anything in it.

    The row count is what tells a researcher an empty file is empty because the
    study has no such data — not because the export is broken.
    """

    kind: str
    filename: str
    rows: int
    # False where this deployment does not collect the data at all: the
    # in-app eye-tracker calibration is off, so only runs recorded before it was
    # switched off have calibration rows.
    collected: bool


class ResearcherOut(BaseModel):
    id: int
    email: str
    name: str
    created_at: datetime | None


class ResearcherCreate(BaseModel):
    email: str = Field(max_length=255)
    name: str = Field(default="", max_length=255)
    # The length rule lives in the service, with the CLI; this only bounds the body.
    password: str = Field(max_length=200)


class PasswordSet(BaseModel):
    password: str = Field(max_length=200)


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)
