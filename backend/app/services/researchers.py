"""Provisioning researcher accounts. There is no self sign-up, so the first
admin has to come from here — see `python -m app.cli`."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.researcher import Researcher

MIN_PASSWORD_LENGTH = 12


class ProvisioningError(Exception):
    """Something the operator can fix — reported without a traceback."""


def normalise_email(email: str) -> str:
    # Login matches case-insensitively; store the form it will be compared against.
    return email.strip().lower()


def _check_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ProvisioningError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")


async def _find(db: AsyncSession, email: str) -> Researcher | None:
    return await db.scalar(
        select(Researcher).where(func.lower(Researcher.email) == normalise_email(email))
    )


async def create_researcher(
    db: AsyncSession, email: str, password: str, name: str = ""
) -> Researcher:
    address = normalise_email(email)
    if "@" not in address:
        raise ProvisioningError(f"{email!r} is not an email address.")
    _check_password(password)
    if await _find(db, address) is not None:
        raise ProvisioningError(
            f"{address} already exists. Use `reset-password` to change its password."
        )

    researcher = Researcher(email=address, password_hash=hash_password(password), name=name.strip())
    db.add(researcher)
    await db.commit()
    await db.refresh(researcher)
    return researcher


async def set_researcher_password(db: AsyncSession, email: str, password: str) -> Researcher:
    _check_password(password)
    researcher = await _find(db, email)
    if researcher is None:
        raise ProvisioningError(f"No researcher with the email {normalise_email(email)}.")

    researcher.password_hash = hash_password(password)
    # A reset that left the old sessions signed in would not be one.
    researcher.token_version += 1
    await db.commit()
    return researcher


async def revoke_researcher_sessions(db: AsyncSession, email: str) -> Researcher:
    """Sign this account out everywhere — for a lost laptop, or a leaver."""
    researcher = await _find(db, email)
    if researcher is None:
        raise ProvisioningError(f"No researcher with the email {normalise_email(email)}.")

    researcher.token_version += 1
    await db.commit()
    return researcher
