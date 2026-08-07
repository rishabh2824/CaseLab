"""Replace run_messages' single-column run_id index with a composite (run_id, persona_id, id) index

Revision ID: 91a6ec5108ab
Revises: f3a1c9d4e6b2
Create Date: 2026-08-07

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '91a6ec5108ab'
down_revision: Union[str, Sequence[str], None] = 'f3a1c9d4e6b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Every read (run_store.py's _loadHistory) is WHERE run_id = ? AND persona_id IN (...)
    # ORDER BY id -- the old single-column run_id index only serves the filter, so Postgres
    # pulled every message for the run into memory before filtering by persona_id and
    # sorting. This composite index covers the filter and the sort together.
    op.drop_index(op.f('ix_run_messages_run_id'), table_name='run_messages')
    op.create_index(
        'ix_run_messages_run_id_persona_id_id',
        'run_messages',
        ['run_id', 'persona_id', 'id'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index('ix_run_messages_run_id_persona_id_id', table_name='run_messages')
    op.create_index(op.f('ix_run_messages_run_id'), 'run_messages', ['run_id'], unique=False)
