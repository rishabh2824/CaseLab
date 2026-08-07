"""drop simulations case_id column

Revision ID: d08e878aa325
Revises: 6980fc1ce2b6
Create Date: 2026-08-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd08e878aa325'
down_revision: Union[str, Sequence[str], None] = '6980fc1ce2b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Write-only: set at insertRun and round-tripped back into the in-memory
    # Run on every read, but never actually read for anything -- every place
    # that needs "which case is this run for" already goes through
    # run.case_snapshot.id (the write-once snapshot JSONB), not this column.
    # Never indexed either (see the composite-index migration two revisions
    # back), for the same underlying reason: nothing queries by it.
    op.drop_column('simulations', 'case_id')


def downgrade() -> None:
    op.add_column('simulations', sa.Column('case_id', sa.Integer(), nullable=False, server_default='0'))
