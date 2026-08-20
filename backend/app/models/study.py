from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
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

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("researchers.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
