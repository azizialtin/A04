"""Top-level router. Feature routers get mounted here as they land."""

from fastapi import APIRouter

from app.api.admin import router as admin_router
from app.api.auth import router as auth_router
from app.api.gaze import router as gaze_router
from app.api.health import router as health_router
from app.api.participant import router as participant_router
from app.api.screen import router as screen_router

router = APIRouter()
router.include_router(health_router)
router.include_router(auth_router)
router.include_router(participant_router)
router.include_router(gaze_router)
router.include_router(screen_router)
router.include_router(admin_router)
