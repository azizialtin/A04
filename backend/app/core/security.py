"""Token signing and password hashing, wired to the app secret."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt

from app.core.config import get_settings

_s = get_settings()


def create_access_token(claims: dict[str, Any], expires: timedelta | None = None) -> str:
    exp = datetime.now(UTC) + (expires or timedelta(hours=_s.JWT_EXPIRE_HOURS))
    return jwt.encode({**claims, "exp": exp}, _s.JWT_SECRET, algorithm=_s.JWT_ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    # Raises jwt.PyJWTError on anything invalid/expired; callers turn that into 401.
    return jwt.decode(token, _s.JWT_SECRET, algorithms=[_s.JWT_ALGORITHM])


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())
