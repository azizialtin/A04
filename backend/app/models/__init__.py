# Importing every model here registers its table on Base.metadata, which both
# create_all (tests) and Alembic autogenerate rely on.
from app.models.audit_log import AuditLog
from app.models.gaze_calibration import GazeCalibration
from app.models.gaze_recording import GazeRecording
from app.models.interaction_log import InteractionLog
from app.models.note import Note
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.researcher import Researcher
from app.models.screen_recording import ScreenRecording
from app.models.session import Session
from app.models.study import Study
from app.models.text_entry import TextEntry
from app.models.video import Video

__all__ = [
    "AuditLog",
    "GazeCalibration",
    "GazeRecording",
    "InteractionLog",
    "Note",
    "Participant",
    "ParticipantVideo",
    "Questionnaire",
    "QuestionnaireResponse",
    "Researcher",
    "ScreenRecording",
    "Session",
    "Study",
    "TextEntry",
    "Video",
]
