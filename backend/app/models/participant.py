from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
