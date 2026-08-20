from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class TextEntry(Base):
    """Free-text the participant submits about a case. `kind` is 'diagnosis'
    today; kept generic so other prompts can reuse the table."""

    __tablename__ = "text_entries"
    __table_args__ = (
        # Looked up as "this participant's diagnosis for this case", which is
        # what makes a resubmit replace rather than duplicate.
        Index("ix_text_entries_participant_video", "participant_id", "video_id", "kind"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE")
    )
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32), default="diagnosis")
    text: Mapped[str] = mapped_column(Text)
    time_spent_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
