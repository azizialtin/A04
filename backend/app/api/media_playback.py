"""Private, seekable media delivery for the persistent LRZ volume."""

from __future__ import annotations

import mimetypes

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.dependencies import _payload_or_401
from app.services.media_download import media_artifact

router = APIRouter()


@router.api_route("/media/{kind}/{media_id}", methods=["GET", "HEAD"])
async def play_media(
    kind: str,
    media_id: int,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    payload = _payload_or_401(token)
    if (
        payload.get("role") != "media_playback"
        or payload.get("kind") != kind
        or payload.get("media_id") != media_id
    ):
        raise HTTPException(401, "Invalid playback token.")
    artifact = await media_artifact(db, kind, media_id, get_settings())
    if artifact.local_path is None:
        raise HTTPException(409, "Storage changed; request a new playback link.")
    return FileResponse(
        artifact.local_path,
        media_type=mimetypes.guess_type(artifact.filename)[0] or "application/octet-stream",
        headers={"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"},
    )
