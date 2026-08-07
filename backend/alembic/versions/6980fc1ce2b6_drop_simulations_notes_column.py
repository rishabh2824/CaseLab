"""drop simulations notes column

Revision ID: 6980fc1ce2b6
Revises: 91a6ec5108ab
Create Date: 2026-08-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6980fc1ce2b6'
down_revision: Union[str, Sequence[str], None] = '91a6ec5108ab'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Notes moved client-side (sessionStorage, keyed by run id) so autosaving
    # them stops taking the simulations row's SELECT ... FOR UPDATE lock on
    # every debounced keystroke -- that lock was serializing against reply
    # persistence (applyDecisions) mid-stream. The PUT .../notes endpoint that
    # wrote this column is gone, so nothing has set a non-empty value here
    # since; every row's notes is already "".
    op.drop_column('simulations', 'notes')


def downgrade() -> None:
    op.add_column('simulations', sa.Column('notes', sa.String(), nullable=False, server_default=''))
