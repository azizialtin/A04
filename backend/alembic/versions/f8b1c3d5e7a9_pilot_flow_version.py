"""Pin pilot flow settings without moving existing sessions."""

from alembic import op
import sqlalchemy as sa

revision = "f8b1c3d5e7a9"
down_revision = "e6a2b8c4d0f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for name, kind, default in (
        ("flow_version", sa.String(32), "legacy"),
        ("think_aloud_mode", sa.String(16), "block"),
        ("think_aloud_count", sa.Integer(), "3"),
    ):
        op.add_column("studies", sa.Column(name, kind, nullable=False, server_default=default))
        op.add_column("participants", sa.Column(name, kind, nullable=True))
    op.execute("UPDATE participants SET flow_version = 'legacy', think_aloud_mode = 'block', "
               "think_aloud_count = 3 WHERE status <> 'registered' OR EXISTS "
               "(SELECT 1 FROM sessions s WHERE s.participant_id = participants.id)")
    _refresh_unstarted_outros(op.get_bind())


def downgrade() -> None:
    if op.get_bind().scalar(sa.text(
        "SELECT EXISTS (SELECT 1 FROM participants WHERE flow_version = 'pilot_20261116')"
    )):
        raise RuntimeError("Cannot discard pilot run settings; restore an earlier backup instead.")
    for table in ("participants", "studies"):
        for name in ("think_aloud_count", "think_aloud_mode", "flow_version"):
            op.drop_column(table, name)


_OUTRO_WORDING = (
    (
        "td_demand",
        "Wie viel Anstrengung müssen Sie in die eben bearbeiteten Fälle investieren, um die bestmögliche Leistung zu erzielen?",
        "Wie viel Anstrengung müssen Sie in den eben bearbeiteten Fall investieren, um die bestmögliche Leistung zu erzielen?",
    ),
    (
        "td_effort",
        "Im Vergleich dazu: Wie viel Anstrengung haben Sie in die eben bearbeiteten Fälle investiert?",
        "Im Vergleich dazu: Wie viel Anstrengung haben Sie in den eben bearbeiteten Fall investiert?",
    ),
    ("auth1", "Ich empfand die Simulation als authentisch.", "Ich empfand die Situation als authentisch"),
    (
        "auth2",
        "Die Simulation hat wie eine echte berufliche Anforderungssituation gewirkt.",
        "Die Situation hat wie eine echte berufliche Anforderungssituation gewirkt",
    ),
)


def _refresh_unstarted_outros(connection) -> None:
    for question_id, old_text, new_text in _OUTRO_WORDING:
        connection.execute(sa.text("""
            UPDATE questionnaires AS q
            SET questions = (
                SELECT jsonb_agg(
                    CASE WHEN item->>'id' = :question_id AND item->>'text' = :old_text
                         THEN jsonb_set(item, '{text}', to_jsonb(CAST(:new_text AS text)))
                         ELSE item END ORDER BY position
                )
                FROM jsonb_array_elements(q.questions) WITH ORDINALITY AS items(item, position)
            )
            WHERE q.placement = 'case_outro'
              AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(q.questions) AS item
                  WHERE item->>'id' = :question_id AND item->>'text' = :old_text
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sessions s JOIN participants p ON p.id = s.participant_id
                  WHERE p.study_id = q.study_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM questionnaire_responses r
                  JOIN questionnaires answered ON answered.id = r.questionnaire_id
                  WHERE answered.study_id = q.study_id
              )
        """), {"question_id": question_id, "old_text": old_text, "new_text": new_text})
