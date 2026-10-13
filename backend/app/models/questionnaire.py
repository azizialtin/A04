from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import SINGLE_PER_STUDY, QuestionnairePlacement, pg_enum

_SINGLE = ", ".join(f"'{p.value}'" for p in SINGLE_PER_STUDY)


class Questionnaire(Base):
    __tablename__ = "questionnaires"
    __table_args__ = (
        Index(
            "uq_questionnaire_single_placement",
            "study_id",
            "placement",
            unique=True,
            postgresql_where=text(f"placement IN ({_SINGLE})"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id", ondelete="CASCADE"), index=True)
    placement: Mapped[QuestionnairePlacement] = mapped_column(pg_enum(QuestionnairePlacement))
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    # Which instrument a page belongs to — "Demographics", "CK-Pretest" — so
    # the time spent on its pages can be added up per section. Free text the
    # researcher owns; empty means the page is a section of its own.
    section: Mapped[str] = mapped_column(String(64), default="", server_default="")
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    # Free-form question list; the shape is the questionnaire engine's contract.
    questions: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class QuestionnaireResponse(Base):
    __tablename__ = "questionnaire_responses"
    __table_args__ = (
        # One response per case: the same short battery is answered once per
        # video…
        Index(
            "uq_qresponse_per_case",
            "questionnaire_id",
            "participant_id",
            "video_id",
            unique=True,
            postgresql_where=text("video_id IS NOT NULL"),
        ),
        # …and once per run for the pre-test pages, which have no case. A plain
        # unique constraint would not catch those: Postgres treats every NULL as
        # distinct, so the same page could be stored twice.
        Index(
            "uq_qresponse_pre_test",
            "questionnaire_id",
            "participant_id",
            unique=True,
            postgresql_where=text("video_id IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    questionnaire_id: Mapped[int] = mapped_column(
        ForeignKey("questionnaires.id", ondelete="RESTRICT"), index=True
    )
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    # Null for the pre-test pages, which are answered once for the whole run.
    video_id: Mapped[int | None] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), index=True, nullable=True
    )
    answers: Mapped[dict] = mapped_column(JSONB, default=dict)
    time_spent_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
