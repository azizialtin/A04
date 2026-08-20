"""Auth dependencies — decode the bearer token and load the actor."""

from __future__ import annotations

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_token
from app.models.participant import Participant
from app.models.researcher import Researcher

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/admin/login")


def _payload_or_401(token: str) -> dict:
    try:
        return decode_token(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from exc


async def get_current_participant(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> Participant:
    payload = _payload_or_401(token)
    pid = payload.get("sub")
    if not pid or payload.get("role") != "participant":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")

    participant = await db.scalar(select(Participant).where(Participant.id == pid))
    if participant is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Participant not found")
    return participant


async def get_current_admin(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> Researcher:
    payload = _payload_or_401(token)
    email = payload.get("sub")
    if not email or payload.get("role") != "admin":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid admin token")

    researcher = await db.scalar(select(Researcher).where(Researcher.email == email))
    if researcher is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Researcher not found")
    if payload.get("ver", 0) != researcher.token_version:
        # The account's sessions were revoked, or its password was reset.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session no longer valid")
    return researcher
