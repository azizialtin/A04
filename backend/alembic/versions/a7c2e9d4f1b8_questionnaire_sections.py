"""Questionnaire pages belong to a section

The researchers want the time a participant spends on the question pages added
up per instrument — "Demographics", "CK-Pretest", and the pre-tests still to
come — not only per page. A page now names its section; empty means it stands
alone. The standard pages seeded before this get their section by title, the
same names the researchers used when they asked. Wording is not touched.

Revision ID: a7c2e9d4f1b8
Revises: e5f7a9c1d3b6
Create Date: 2026-10-13
"""

from alembic import op
import sqlalchemy as sa

revision = "a7c2e9d4f1b8"
down_revision = "e5f7a9c1d3b6"
branch_labels = None
depends_on = None

# A frozen copy of the seeded titles, so this migration keeps doing the same
# thing after the application's content moves on.
SECTION_BY_TITLE = {
    "Angaben zur Person": "Demographics",
    "Fachdidaktisches Wissen": "PCK-Pretest",
    "Fachwissen Programmierung": "CK-Pretest",
    "Fachwissen Debugging": "CK-Pretest",
}


def upgrade() -> None:
    op.add_column(
        "questionnaires",
        sa.Column("section", sa.String(length=64), nullable=False, server_default=""),
    )
    questionnaires = sa.table(
        "questionnaires",
        sa.column("title", sa.String),
        sa.column("placement", sa.String),
        sa.column("section", sa.String),
    )
    for title, section in SECTION_BY_TITLE.items():
        op.execute(
            questionnaires.update()
            .where(questionnaires.c.title == title, questionnaires.c.placement == "pre_test")
            .values(section=section)
        )


def downgrade() -> None:
    op.drop_column("questionnaires", "section")
