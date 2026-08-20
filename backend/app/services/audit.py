from __future__ import annotations

import logging

from app.core.database import SessionLocal
from app.models.audit_log import AuditLog
from app.models.enums import ActorType

logger = logging.getLogger(__name__)


async def record_audit(
    actor_email: str | None,
    actor_type: ActorType,
    action: str,
    ip_address: str | None = None,
    meta: dict | None = None,
) -> None:
    try:
        async with SessionLocal() as db:
            db.add(
                AuditLog(
                    actor_email=actor_email,
                    actor_type=actor_type,
                    action=action,
                    ip_address=ip_address,
                    meta=meta or {},
                )
            )
            await db.commit()
    except Exception:
        logger.exception("could not write audit entry %s", action)
