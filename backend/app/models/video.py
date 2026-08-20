from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import PhaseType, pg_enum


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    phase_type: Mapped[PhaseType] = mapped_column(pg_enum(PhaseType), default=PhaseType.training)

    # Content for the right-hand rail of the case screen.
    task_description: Mapped[str] = mapped_column(Text, default="")
    info_text: Mapped[str] = mapped_column(Text, default="")
    student_task_text: Mapped[str] = mapped_column(Text, default="")

    time_limit_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gcp_filename: Mapped[str | None] = mapped_column(String(500), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
