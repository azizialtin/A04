"""Deliver a local attachment using its scoped download link."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import _payload_or_401
from app.models.researcher import Researcher
from app.services.media_download import attachment, media_artifact

router = APIRouter()


@router.get("/downloads/{kind}/{media_id}", name="download_media")
async def download_media(
    kind: str,
    media_id: int,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    payload = _payload_or_401(token)
    if (
        payload.get("role") != "media_download"
        or payload.get("kind") != kind
        or payload.get("media_id") != media_id
    ):
        raise HTTPException(401, "Invalid download token.")
    admin = await db.scalar(select(Researcher).where(Researcher.email == payload.get("sub")))
    if admin is None or payload.get("ver") != admin.token_version:
        raise HTTPException(401, "Download link is no longer valid.")
    artifact = await media_artifact(db, kind, media_id, get_settings())
    if artifact.local_path is None:
        raise HTTPException(409, "Storage changed; request a new download link.")
    return FileResponse(
        artifact.local_path,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": attachment(artifact.filename),
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
    )
