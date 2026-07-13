"""Case domain logic.

Orchestrates the repository reads/writes and shapes responses. Acquires the db
client so the router layer stays free of any data access. Holds no raw SQL.
"""

import asyncio
import logging
import uuid
from collections import defaultdict

import libsql_client
from fastapi import HTTPException

from models.admin import AdminRole
from services import case_repository as repo
from services.admin_auth import CurrentAdmin
from services.db import get_db_client
from services.persona_shapes import photo_ref

logger = logging.getLogger("caselab.cases")

ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."


def _authorize_case_access(owner_admin_id: str | None, admin: CurrentAdmin) -> None:
    if admin.role == AdminRole.SUPER:
        return
    if owner_admin_id != admin.id:
        raise HTTPException(status_code=403, detail="You do not have access to this case.")


def _is_unique_violation(exc: Exception) -> bool:
    """Whether exc looks like a UNIQUE constraint violation from the DB.

    Defense in depth for a race between the pre-check in create_case/
    update_case and the write itself; the partial UNIQUE index
    (idx_cases_access_code_upper, see schema.txt) is the actual guarantee.
    """
    if not isinstance(exc, libsql_client.LibsqlError):
        return False
    return "UNIQUE" in (exc.code or "").upper() or "UNIQUE" in (exc.explanation or "").upper()


# --- persona assembly ------------------------------------------------------
#
# build_case_personas fetches every persona/file/referral belonging to a case
# in 3 concurrent round-trips


def _assemble_persona_tree(
    persona_id: str,
    personas_by_id: dict[str, dict],
    files_by_persona: dict[str, list[dict]],
    referrals_by_parent: dict[str, list[dict]],
) -> dict:
    persona = personas_by_id.get(persona_id)
    if persona is None:
        # A referral pointing at a persona_id absent from this case's own
        # persona set is corrupted data (an FK-integrity failure, not a bad
        # request) — a 404 here would incorrectly tell the client "fix your
        # request", when there's nothing the client can do about it.
        logger.error(
            "Referral tree references missing persona_id=%s (not in this case's personas)",
            persona_id,
        )
        raise HTTPException(status_code=500, detail="Failed to load case data.")
    profile_photo = photo_ref(persona, presign=False)
    files = [
        {
            "file": photo_ref(row, presign=False),
            "share_conditions": row["share_conditions"],
            "perceived_contents": row["perceived_contents"],
        }
        for row in files_by_persona.get(persona_id, [])
    ]
    referrals = []
    for row in referrals_by_parent.get(persona_id, []):
        referred_persona = _assemble_persona_tree(
            row["referred_persona_id"], personas_by_id, files_by_persona, referrals_by_parent
        )
        referrals.append(
            {
                # `name` mirrors the nested persona's own name (kept in sync by
                # the admin form) — informational for populating the edit UI;
                # not part of the create/update request contract.
                "name": referred_persona["name"],
                "conditions": row["condition_trigger"],
                "persona": referred_persona,
            }
        )
    return {
        "name": persona["name"],
        "role": persona["role"],
        "profile_photo": profile_photo,
        "known_facts": persona["known_facts"],
        "personality_traits": persona["personality_traits"],
        "availability_minutes": persona["availability_duration"],
        # file_count/referral_out_count are informational (derived from the
        # arrays below) for populating the edit UI's counters; not part of the
        # create/update request contract.
        "file_count": len(files),
        "files": files,
        "referral_out_count": len(referrals),
        "referrals": referrals,
    }


async def build_case_personas(client, case_id: str) -> list[dict]:
    """Fetch every persona/file/referral for the case (3 round-trips total,
    regardless of case size) and assemble the root -> referral tree in memory."""
    personas, files, referrals = await asyncio.gather(
        repo.fetch_personas_for_case(client, case_id),
        repo.fetch_persona_files_for_case(client, case_id),
        repo.fetch_referrals_for_case(client, case_id),
    )
    personas_by_id = {row["id"]: row for row in personas}
    files_by_persona = defaultdict(list)
    for row in files:
        files_by_persona[row["persona_id"]].append(row)
    referrals_by_parent = defaultdict(list)
    for row in referrals:
        referrals_by_parent[row["parent_persona_id"]].append(row)

    # A root is any persona in the case that nothing refers to.
    referred_ids = {row["referred_persona_id"] for row in referrals}
    root_ids = sorted(
        (pid for pid in personas_by_id if pid not in referred_ids),
        key=lambda pid: personas_by_id[pid]["name"],
    )
    return [
        _assemble_persona_tree(persona_id, personas_by_id, files_by_persona, referrals_by_parent)
        for persona_id in root_ids
    ]


async def save_case_structure(client, case_id: str, payload, statements: list) -> None:
    """Append every persona/file/referral insert statement for this case to
    ``statements``. Nothing is executed here — the caller runs the full list
    through ``client.batch(...)`` alongside the case row's own statement, so
    the whole write commits or rolls back together."""
    for persona in payload.personas:
        persona_id = await repo.insert_persona(client, case_id, persona, statements)
        if persona.referrals:
            await repo.insert_referrals(client, case_id, persona_id, persona.referrals, statements)


# --- operations (called by the router) -------------------------------------


async def create_case(payload, admin: CurrentAdmin) -> dict:
    client = get_db_client()
    if payload.access_code and await repo.access_code_taken(client, payload.access_code):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    case_id = uuid.uuid4().hex
    try:
        statements = [repo.insert_case(case_id, payload, owner_admin_id=admin.id)]
        await save_case_structure(client, case_id, payload, statements)
        await client.batch(statements)
    except Exception as exc:
        if _is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        logger.exception("Failed to create case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to create case.") from exc
    return {"case_id": case_id}


async def list_cases(admin: CurrentAdmin) -> dict:
    client = get_db_client()
    # None (no filter) only for a super admin, who also sees legacy
    # NULL-owner cases that a plain owner_admin_id = ? filter would miss.
    owner_filter = None if admin.role == AdminRole.SUPER else admin.id
    rows = await repo.fetch_cases(client, owner_admin_id=owner_filter)
    return {
        "cases": [
            {"id": row["id"], "case_name": row["case_name"], "access_code": row["access_code"]}
            for row in rows
        ]
    }


async def get_case(case_id: str, admin: CurrentAdmin) -> dict:
    client = get_db_client()
    case = await repo.fetch_case(client, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    _authorize_case_access(case["owner_admin_id"], admin)
    personas = await build_case_personas(client, case["id"])
    return {
        "case": {
            "id": case["id"],
            "case_name": case["case_name"],
            "access_code": case["access_code"],
            "initial_brief": case["initial_brief"],
            "common_information": case["common_information"],
            "simulation_duration": case["simulation_duration"],
            "total_non_referred_personas": case["non_referred"],
            "personas": personas,
        }
    }


async def update_case(case_id: str, payload, admin: CurrentAdmin) -> dict:
    client = get_db_client()
    existing = await repo.fetch_case_owner(client, case_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    _authorize_case_access(existing["owner_admin_id"], admin)
    if payload.access_code and await repo.access_code_taken(
        client, payload.access_code, exclude_case_id=case_id
    ):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    try:
        # PRAGMA first: delete_personas_for_case relies on ON DELETE CASCADE
        # (personas -> persona_files/persona_referrals) to clean up, but
        # SQLite defaults foreign-key enforcement OFF per-connection, and the
        # libsql HTTP client opens a fresh implicit connection per batch — so
        # the pragma has to ride in the same batch as the delete, same as
        # admin_repository.delete does for the admins -> cases cascade.
        statements = [
            ("PRAGMA foreign_keys = ON", ()),
            repo.update_case_fields(case_id, payload),
            repo.delete_personas_for_case(case_id),
        ]
        await save_case_structure(client, case_id, payload, statements)
        await client.batch(statements)
    except Exception as exc:
        if _is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        logger.exception("Failed to update case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to update case.") from exc
    return {"case_id": case_id}


async def delete_case(case_id: str, admin: CurrentAdmin) -> dict:
    client = get_db_client()
    existing = await repo.fetch_case_owner(client, case_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    _authorize_case_access(existing["owner_admin_id"], admin)
    await repo.delete_case(client, case_id)
    return {"ok": True}
