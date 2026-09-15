from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Study(Base):
    __tablename__ = "studies"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")

    # SoSciSurvey handoff. The participant id rides in the query string as
    # ?<sosci_id_param>=<id> so the survey rows can be joined to ours later.
    sosci_pretest_url: Mapped[str] = mapped_column(String(1000), default="")
    sosci_posttest_url: Mapped[str] = mapped_column(String(1000), default="")
    sosci_id_param: Mapped[str] = mapped_column(String(64), default="id")

    # Participant-facing wording the researchers may change without a deploy —
    # the welcome page, for now. Keys are the fields of `StudyTexts`; an empty
    # or missing value means the app's own default text.
    texts: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    # What a new video starts from: the timer, and the task and info texts a
    # video can choose to follow instead of carrying its own. Keys are the
    # fields of `StudyVideoDefaults`.
    video_defaults: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    # How many training cases are worked through before their think-aloud
    # screens run one after the other. 1 — the default — is a think-aloud
    # straight after each case. Only the training phase batches; the pre-test
    # and post-test case are always narrated immediately. Copied onto the
    # participant when their run opens, so a change never reorders a sitting
    # that has already begun.
    think_aloud_batch_size: Mapped[int] = mapped_column(Integer, default=1, server_default="1")

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("researchers.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
