"""Enumerations used across the models and API."""

import enum

from sqlalchemy import Enum as SAEnum


class PhaseType(enum.StrEnum):
    pre_test = "pre_test"
    training = "training"
    post_test = "post_test"


class ParticipantStatus(enum.StrEnum):
    registered = "registered"
    active = "active"
    completed = "completed"


class QuestionnairePlacement(enum.StrEnum):
    """Where a battery is asked. `pre_test` runs before the study proper and has
    no case attached; the other two belong to one case each."""

    pre_test = "pre_test"
    diagnosis = "diagnosis"
    case_outro = "case_outro"


# A study has as many pre-test pages as it likes, but only one diagnosis battery
# and one outro battery — those two are rendered inside a screen of their own,
# and a second of either has nowhere to go. Enforced by a partial unique index.
SINGLE_PER_STUDY = (QuestionnairePlacement.diagnosis, QuestionnairePlacement.case_outro)


class QuestionType(enum.StrEnum):
    likert = "likert"
    multiple_choice = "multiple_choice"
    free_text = "free_text"
    slider = "slider"
    number = "number"


class ActorType(enum.StrEnum):
    admin = "admin"
    participant = "participant"
    system = "system"


def pg_enum(e: type[enum.Enum]) -> SAEnum:
    # Store as varchar with no native pg type and no check constraint: the value
    # stays typed in Python but the column is a plain string, which keeps the
    # migrations boring and lets several tables reuse the same enum freely.
    return SAEnum(e, native_enum=False, create_constraint=False, length=32)
