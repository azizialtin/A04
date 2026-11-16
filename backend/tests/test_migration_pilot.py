import importlib.util
from copy import deepcopy
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

from app.core.database import Base
from app.models.enums import QuestionnairePlacement
from app.models.participant import Participant
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.models.study import Study


def migration_module():
    path = (
        Path(__file__).resolve().parents[1] / "alembic/versions/f8b1c3d5e7a9_pilot_flow_version.py"
    )
    spec = importlib.util.spec_from_file_location("pilot_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


async def test_pilot_migration_preserves_started_runs_and_custom_wording(db):
    migration = migration_module()
    originals = [
        {"id": qid, "type": "slider", "text": old, "custom_metadata": "retained"}
        for qid, old, _ in migration._OUTRO_WORDING
    ]
    studies = [Study(name=name) for name in ("Unstarted", "Started", "Answered", "Custom")]
    db.add_all(studies)
    await db.flush()
    pages = [
        Questionnaire(
            study_id=s.id,
            title="Outro",
            placement=QuestionnairePlacement.case_outro,
            questions=deepcopy(originals),
        )
        for s in studies
    ]
    pages[3].questions[0]["text"] = "Researcher custom wording"
    participants = [Participant(id=f"migration-{i}", study_id=s.id) for i, s in enumerate(studies)]
    db.add_all([*pages, *participants])
    await db.flush()
    # The existing session, not status alone, must protect even an inconsistent imported run.
    db.add(Session(participant_id=participants[1].id, current_step_index=17))
    db.add(
        QuestionnaireResponse(
            questionnaire_id=pages[2].id,
            participant_id=participants[2].id,
            answers={"td_demand": 4},
        )
    )
    await db.flush()
    connection = await db.connection()

    def migrate(conn):
        context = MigrationContext.configure(conn)
        with Operations.context(context):
            migration.downgrade()
            migration.upgrade()
        assert compare_metadata(context, Base.metadata) == []

    await connection.run_sync(migrate)
    await db.refresh(participants[1])
    assert participants[1].flow_version == "legacy"
    assert participants[1].think_aloud_mode == "block"
    assert participants[1].think_aloud_count == 3
    assert (await db.execute(text("SELECT current_step_index FROM sessions"))).scalar_one() == 17
    for page in pages:
        await db.refresh(page)
    updated_texts = [new for _, _, new in migration._OUTRO_WORDING]
    assert [q["text"] for q in pages[0].questions] == updated_texts
    assert pages[1].questions == originals
    assert pages[2].questions == originals
    assert pages[3].questions[0]["text"] == "Researcher custom wording"
    assert [q["text"] for q in pages[3].questions[1:]] == updated_texts[1:]
    assert all(q["custom_metadata"] == "retained" for q in pages[0].questions)
    for study in studies:
        await db.refresh(study)
        assert study.flow_version == "legacy"
        assert study.think_aloud_mode == "block"
