from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Session(Base):
    """A participant's single run. `current_step_index` is the step-script
    pointer; it only ever moves forward, so a refresh resumes in place."""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("participants.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    current_step_index: Mapped[int] = mapped_column(Integer, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
