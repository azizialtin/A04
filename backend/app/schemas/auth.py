from __future__ import annotations

from pydantic import BaseModel, Field


class ParticipantLoginRequest(BaseModel):
    participant_id: str = Field(min_length=1, max_length=64)


class AdminLoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=255)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
