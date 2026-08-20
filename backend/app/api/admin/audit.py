"""Who did what, for the security-relevant admin actions."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.models.audit_log import AuditLog
from app.models.researcher import Researcher

router = APIRouter()


@router.get("/audit")
async def list_audit(
    limit: int = Query(200, ge=1, le=1000),
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[dict]]:
    rows = (
        (
            await db.execute(
                select(AuditLog)
                .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return {
        "items": [
            {
                "id": a.id,
                "actor_email": a.actor_email,
                "action": a.action,
                "created_at": a.created_at.isoformat(),
                "meta": a.meta,
            }
            for a in rows
        ]
    }
