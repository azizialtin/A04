from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import ParticipantStatus, pg_enum


class Participant(Base):
    """Consent is not recorded here: it is taken on paper / in the first SoSci
    survey, and the paper record is the one that counts."""

    __tablename__ = "participants"

    # Researcher-assigned id; the participant logs in with just this.
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id", ondelete="CASCADE"), index=True)
    status: Mapped[ParticipantStatus] = mapped_column(
        pg_enum(ParticipantStatus), default=ParticipantStatus.registered
    )
    # Which of the study's video sets this participant was dealt, for the
    # analysis and for keeping the deal balanced. Their actual run is the copy
    # in `participant_videos`; deleting the set leaves that copy alone.
    video_set_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("video_sets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # The study's think-aloud batch size as it stood when this run opened. Null
    # for a run that started before the setting existed, which then follows the
    # study. Pinned so that editing the study cannot reorder a sitting that is
    # already under way.
    think_aloud_batch_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
