from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app import cli
from app.models.questionnaire import Questionnaire
from app.models.session import Session
from app.services.researchers import ProvisioningError
from app.services.study_content import DEFAULT_BATTERIES


def use_test_session(monkeypatch, db):
    @asynccontextmanager
    async def session_factory():
        yield db

    monkeypatch.setattr(cli, "SessionLocal", session_factory)


async def test_seed_cli_refuses_started_run_even_at_first_step(
    db, seed_study, seed_participant, monkeypatch
):
    use_test_session(monkeypatch, db)
    session = Session(participant_id=seed_participant.id, current_step_index=0)
    db.add(session)
    await db.flush()

    with pytest.raises(ProvisioningError, match="started runs"):
        await cli._seed_questionnaires(SimpleNamespace(study_id=seed_study.id))

    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 0
    assert session.current_step_index == 0


async def test_seed_cli_still_seeds_unstarted_study_idempotently(
    db, seed_study, monkeypatch, capsys
):
    use_test_session(monkeypatch, db)
    args = SimpleNamespace(study_id=seed_study.id)
    await cli._seed_questionnaires(args)
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == len(
        DEFAULT_BATTERIES
    )

    await cli._seed_questionnaires(args)
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == len(
        DEFAULT_BATTERIES
    )
    assert "already has every standard battery" in capsys.readouterr().out
