"""Split simulation run storage into snapshot/state/notes columns + run_messages table

Revision ID: f3a1c9d4e6b2
Revises: a737db9560d9
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'f3a1c9d4e6b2'
down_revision: Union[str, Sequence[str], None] = 'a737db9560d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # simulations.data conflated a write-once snapshot, a small mutable state
    # bag, and the full chat transcript in one JSONB blob, so every mutating
    # write (including the notes autosave) rewrote the whole thing. Runs are
    # ephemeral and TTL-bounded (services/simulation/run_store.py), so rather
    # than backfill existing rows into the new shape, we drop them outright —
    # any simulation in progress at deploy time restarts.
    op.execute("DELETE FROM simulations")

    op.add_column('simulations', sa.Column('case_id', sa.Integer(), nullable=False))
    op.add_column('simulations', sa.Column('start_time', sa.Float(), nullable=False))
    op.add_column('simulations', sa.Column('snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=False))
    op.add_column('simulations', sa.Column('state', postgresql.JSONB(astext_type=sa.Text()), nullable=False))
    op.add_column(
        'simulations',
        sa.Column('notes', sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default=''),
    )
    op.drop_column('simulations', 'data')

    op.create_table(
        'run_messages',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('run_id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('persona_id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('role', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('content', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.ForeignKeyConstraint(['run_id'], ['simulations.run_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_run_messages_run_id'), 'run_messages', ['run_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_run_messages_run_id'), table_name='run_messages')
    op.drop_table('run_messages')

    # Same reasoning as upgrade(): runs are ephemeral, so empty the table
    # rather than reshaping data back into the old blob.
    op.execute("DELETE FROM simulations")
    op.add_column('simulations', sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False))
    op.drop_column('simulations', 'notes')
    op.drop_column('simulations', 'state')
    op.drop_column('simulations', 'snapshot')
    op.drop_column('simulations', 'start_time')
    op.drop_column('simulations', 'case_id')
