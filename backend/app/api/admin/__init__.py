"""Researcher/admin endpoints. Admin-only, mounted under /admin.

Split by what each part is for rather than run together behind section
comments — the file had grown past a thousand lines.
"""

from fastapi import APIRouter, Depends

from app.core.dependencies import get_current_admin

from . import (
    audit,
    exports,
    gaze,
    participants,
    questionnaires,
    researchers,
    stats,
    studies,
    video_sets,
    videos,
)

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(get_current_admin)])

for module in (
    studies,
    videos,
    video_sets,
    participants,
    questionnaires,
    exports,
    gaze,
    stats,
    audit,
    researchers,
):
    router.include_router(module.router)
