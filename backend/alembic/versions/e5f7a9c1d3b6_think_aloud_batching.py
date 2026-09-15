"""Think-aloud screens can run in blocks, in the training phase

A study says how many training cases are worked through before their
think-aloud screens play one after the other. 1 — the default, and what every
run has done so far — is a think-aloud straight after each case. The pre-test
and post-test case never batch.

The value is copied onto the participant when their run opens, so editing the
study cannot reorder a sitting that is already under way. A run that had
already opened before this migration is pinned to 1 here for the same reason —
left NULL it would follow the study, and the first edit after the deploy would
reorder it mid-sitting. NULL therefore means "has not started yet".

Revision ID: e5f7a9c1d3b6
Revises: d4e6f8a0b2c4
Create Date: 2026-09-14
"""

from alembic import op
import sqlalchemy as sa

revision = "e5f7a9c1d3b6"
down_revision = "d4e6f8a0b2c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "studies",
        sa.Column("think_aloud_batch_size", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "participants",
        sa.Column("think_aloud_batch_size", sa.Integer(), nullable=True),
    )
    # Everyone whose run has already opened has been seeing a think-aloud after
    # every case; pin that, so a later edit cannot reorder them mid-sitting.
    op.execute("UPDATE participants SET think_aloud_batch_size = 1 WHERE status <> 'registered'")


def downgrade() -> None:
    op.drop_column("participants", "think_aloud_batch_size")
    op.drop_column("studies", "think_aloud_batch_size")
