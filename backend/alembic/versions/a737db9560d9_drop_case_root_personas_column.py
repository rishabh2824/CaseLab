"""drop case root_personas column

Revision ID: a737db9560d9
Revises: 786f37b00c84
Create Date: 2026-08-04 01:29:55.858778

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a737db9560d9'
down_revision: Union[str, Sequence[str], None] = '786f37b00c84'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_column('cases', 'root_personas')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('cases', sa.Column('root_personas', sa.Integer(), nullable=False, server_default='0'))
