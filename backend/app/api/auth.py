"""Login endpoints. Participants sign in with an id only; admins use email +
password with a small per-ip throttle."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.middleware import client_ip
from app.core.ratelimit import RateLimiter
from app.core.security import create_access_token, hash_password, verify_password
from app.models.enums import ActorType, ParticipantStatus
from app.models.participant import Participant
from app.models.researcher import Researcher
from app.models.session import Session
from app.models.study import Study
from app.schemas.auth import AdminLoginRequest, ParticipantLoginRequest, TokenResponse
from app.services.audit import record_audit
from app.services.event_logger import log_event
from app.services.video_sets import deal_on_first_login

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

admin_attempts = RateLimiter(limit=10)
# Participant ids are short and handed out on paper, so the login form is the
# one place they could be guessed at. The limit is loose enough that a mistyped
# id in the lab is no trouble and tight enough that walking the space is not
# worth trying.
participant_attempts = RateLimiter(limit=15)

# Checked when the email is unknown so response timing doesn't reveal which
# accounts exist.
_DECOY_HASH = hash_password("decoy-not-a-real-credential")


@router.post("/participant/login", response_model=TokenResponse)
async def participant_login(
    body: ParticipantLoginRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    participant_attempts.check(
        client_ip(request, settings.TRUSTED_PROXY_HOPS) or "unknown",
        "Too many attempts. Wait a minute, then ask the study team for help.",
    )
    pid = body.participant_id.strip()
    participant = await db.scalar(
        select(Participant).where(func.lower(Participant.id) == pid.lower())
    )
    if participant is None:
        # Only ids an admin pre-registered may log in — no self sign-up.
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Unknown participant id. Please check with the study team.",
        )
    if participant.status == ParticipantStatus.completed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You have already completed the study. Thank you!",
        )

    # First login opens the single run and flips the status. It is also the
    # moment a participant without a hand-picked sequence is dealt one of the
    # study's video sets, so the balance counts the people who turned up, and
    # the moment the think-aloud batch size is pinned — after this the study
    # can be edited without reordering a sitting that is already under way.
    dealt = None
    if participant.status == ParticipantStatus.registered:
        dealt = await deal_on_first_login(db, participant)
        study = await db.get(Study, participant.study_id)
        participant.think_aloud_batch_size = study.think_aloud_batch_size if study else 1
        db.add(Session(participant_id=participant.id))
        participant.status = ParticipantStatus.active
        await db.commit()

    # A run is one sitting, so the token does not need to outlive the day it
    # was issued on — a laptop left open is a much smaller window than 24 h.
    token = create_access_token(
        {"sub": participant.id, "role": "participant"},
        expires=timedelta(hours=settings.PARTICIPANT_TOKEN_HOURS),
    )
    background_tasks.add_task(log_event, participant_id=participant.id, event_type="login")
    if dealt is not None:
        background_tasks.add_task(
            log_event,
            participant_id=participant.id,
            event_type="video_set_dealt",
            payload={"video_set_id": dealt.id, "video_set_name": dealt.name},
        )
    return TokenResponse(access_token=token)


@router.post("/admin/login", response_model=TokenResponse)
async def admin_login(
    body: AdminLoginRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    ip = client_ip(request, settings.TRUSTED_PROXY_HOPS) or "unknown"
    admin_attempts.check(ip)

    researcher = await db.scalar(
        select(Researcher).where(func.lower(Researcher.email) == body.email.strip().lower())
    )
    # Always verify a hash to keep timing flat whether or not the email exists.
    ok = verify_password(body.password, researcher.password_hash if researcher else _DECOY_HASH)
    if researcher is None or not ok:
        background_tasks.add_task(
            record_audit,
            actor_email=body.email,
            actor_type=ActorType.admin,
            action="login_failed",
            ip_address=ip,
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    token = create_access_token(
        {"sub": researcher.email, "role": "admin", "ver": researcher.token_version}
    )
    background_tasks.add_task(
        record_audit,
        actor_email=researcher.email,
        actor_type=ActorType.admin,
        action="login_succeeded",
        ip_address=ip,
    )
    return TokenResponse(access_token=token)
