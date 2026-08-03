"""flatten persona graph structure

Revision ID: 786f37b00c84
Revises: 83a3b6111f69
Create Date: 2026-08-03 02:39:19.927624

"""
import json
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '786f37b00c84'
down_revision: Union[str, Sequence[str], None] = '83a3b6111f69'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# One-time conversion of the old nested persona tree into the new flat
# {personas, referrals, roots} shape. Recursive here is fine — this walker
# never runs again after this migration; the app's own build_structure()
# (services/cases.py) is flat from here on.
def flattenTree(personas: list[dict]) -> dict:
    flat_personas: list[dict] = []
    referrals: list[dict] = []
    roots: list[str] = []

    def walk(persona: dict, *, is_root: bool) -> str:
        # Final id regeneration ever — from here on personas keep whatever id
        # they're given (see build_structure in services/cases.py).
        persona_id = uuid.uuid4().hex
        flat_personas.append(
            {
                "id": persona_id,
                "name": persona.get("name") or "",
                "role": persona.get("role") or "",
                "profile_photo": persona.get("profile_photo"),
                "known_facts": persona.get("known_facts"),
                "personality_traits": persona.get("personality_traits"),
                "availability_minutes": persona.get("availability_minutes"),
                "files": persona.get("files") or [],
            }
        )
        if is_root:
            roots.append(persona_id)
        for referral in persona.get("referrals") or []:
            child_id = walk(referral["persona"], is_root=False)
            referrals.append(
                {"from_id": persona_id, "to_id": child_id, "conditions": referral.get("conditions")}
            )
        return persona_id

    for persona in personas:
        walk(persona, is_root=True)

    return {"personas": flat_personas, "referrals": referrals, "roots": roots}


# Inverse of flattenTree, for downgrade().
def nestTree(structure: dict) -> list[dict]:
    personas_by_id = {p["id"]: p for p in structure.get("personas") or []}
    children_of: dict[str, list[dict]] = {}
    for referral in structure.get("referrals") or []:
        children_of.setdefault(referral["from_id"], []).append(referral)

    def build(persona_id: str) -> dict:
        persona = personas_by_id[persona_id]
        return {
            "name": persona.get("name") or "",
            "role": persona.get("role") or "",
            "profile_photo": persona.get("profile_photo"),
            "known_facts": persona.get("known_facts"),
            "personality_traits": persona.get("personality_traits"),
            "availability_minutes": persona.get("availability_minutes"),
            "files": persona.get("files") or [],
            "referrals": [
                {"conditions": referral.get("conditions"), "persona": build(referral["to_id"])}
                for referral in children_of.get(persona_id, [])
            ],
        }

    return [build(root_id) for root_id in structure.get("roots") or []]


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, structure FROM cases")).fetchall()
    for row in rows:
        new_structure = flattenTree(row.structure.get("personas") or [])
        bind.execute(
            sa.text("UPDATE cases SET structure = CAST(:structure AS JSONB) WHERE id = :id"),
            {"structure": json.dumps(new_structure), "id": row.id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, structure FROM cases")).fetchall()
    for row in rows:
        old_structure = {"personas": nestTree(row.structure)}
        bind.execute(
            sa.text("UPDATE cases SET structure = CAST(:structure AS JSONB) WHERE id = :id"),
            {"structure": json.dumps(old_structure), "id": row.id},
        )
