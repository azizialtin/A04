from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SectionAttempt(Base):
    __tablename__ = "section_attempts"
    __table_args__ = (UniqueConstraint("participant_id", "section_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    section_key: Mapped[str] = mapped_column(String(64))
    section: Mapped[str] = mapped_column(String(255))
    started_client_ts: Mapped[int] = mapped_column(BigInteger)
    deadline_ms: Mapped[int] = mapped_column(BigInteger)
    ended_client_ts: Mapped[int | None] = mapped_column(BigInteger)
    finished_server_ms: Mapped[int | None] = mapped_column(BigInteger)
    exit_reason: Mapped[str | None] = mapped_column(String(32))


class QuestionnaireVisit(Base):
    __tablename__ = "questionnaire_visits"

    # Client-generated identity makes entering and leaving retryable.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    questionnaire_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("questionnaires.id", ondelete="RESTRICT"), index=True
    )
    section_key: Mapped[str] = mapped_column(String(64))
    step_index: Mapped[int] = mapped_column(Integer)
    entered_client_ts: Mapped[int] = mapped_column(BigInteger)
    exited_client_ts: Mapped[int | None] = mapped_column(BigInteger)
    exit_reason: Mapped[str | None] = mapped_column(String(32))
    is_review: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    submitted_answers: Mapped[dict | None] = mapped_column(JSONB)
    finish_request_id: Mapped[str | None] = mapped_column(String(36), unique=True)
