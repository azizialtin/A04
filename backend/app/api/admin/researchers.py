"""Researcher accounts from the admin UI.

What `python -m app.cli` does — create an account, reset its password, sign it
out everywhere — for the researcher who runs the study and has no shell on
the server. Every admin is equal, there are no roles, so any of them can add
a colleague; the audit log says who did what.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_admin
from app.core.security import create_access_token, verify_password
from app.models.researcher import Researcher
from app.schemas.admin import PasswordChange, PasswordSet, ResearcherCreate, ResearcherOut
from app.schemas.auth import TokenResponse
from app.services.researchers import (
    ProvisioningError,
    create_researcher,
    find_researcher,
    revoke_researcher_sessions,
    set_researcher_password,
)

from ._common import _audit

router = APIRouter()


async def _researcher_or_404(db: AsyncSession, researcher_id: int) -> Researcher:
    researcher = await db.get(Researcher, researcher_id)
    if researcher is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Researcher not found.")
    return researcher


@router.get("/researchers", response_model=list[ResearcherOut])
async def list_researchers(db: AsyncSession = Depends(get_db)) -> list[Researcher]:
    return list((await db.execute(select(Researcher).order_by(Researcher.email))).scalars().all())


@router.post("/researchers", response_model=ResearcherOut, status_code=status.HTTP_201_CREATED)
async def create_account(
    body: ResearcherCreate,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> Researcher:
    if await find_researcher(db, body.email) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "An account with this email address already exists."
        )
    try:
        researcher = await create_researcher(db, body.email, body.password, body.name)
    except ProvisioningError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from None
    _audit(background_tasks, admin, "researcher_created", {"email": researcher.email})
    return researcher


@router.post("/researchers/{researcher_id}/password", response_model=ResearcherOut)
async def reset_password(
    researcher_id: int,
    body: PasswordSet,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> Researcher:
    """Give an account a new password; its open sessions end with it — this
    one too, when an admin resets their own (the UI steers them to /me/password)."""
    target = await _researcher_or_404(db, researcher_id)
    try:
        researcher = await set_researcher_password(db, target.email, body.password)
    except ProvisioningError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from None
    _audit(background_tasks, admin, "researcher_password_reset", {"email": researcher.email})
    return researcher


@router.post("/researchers/{researcher_id}/revoke", response_model=ResearcherOut)
async def revoke_sessions(
    researcher_id: int,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> Researcher:
    target = await _researcher_or_404(db, researcher_id)
    researcher = await revoke_researcher_sessions(db, target.email)
    _audit(background_tasks, admin, "researcher_sessions_revoked", {"email": researcher.email})
    return researcher


@router.post("/me/password", response_model=TokenResponse)
async def change_own_password(
    body: PasswordChange,
    background_tasks: BackgroundTasks,
    admin: Researcher = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """Change one's own password. The current one is asked for, so a session
    left open on a shared lab machine cannot be used to take the account over."""
    if not verify_password(body.current_password, admin.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The current password is wrong.")
    try:
        researcher = await set_researcher_password(db, admin.email, body.new_password)
    except ProvisioningError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from None
    _audit(background_tasks, admin, "password_changed")
    # The change just ended every session of the account, this one included;
    # hand back a token for the new one so the admin does not land on the login.
    return TokenResponse(
        access_token=create_access_token(
            {"sub": researcher.email, "role": "admin", "ver": researcher.token_version}
        )
    )
