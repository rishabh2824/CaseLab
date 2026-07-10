"""CaseForm domain logic.

Orchestrates the repository reads/writes and shapes responses. Acquires the db
client so the router layer stays free of any data access. Holds no raw SQL.
"""

import asyncio
import logging
import uuid
from collections import defaultdict

import libsql_client
from fastapi import HTTPException

from services import case_repository as repo
from services.admin_auth import SUPER_ADMIN_ROLE, CurrentAdmin
from services.db import get_db_client
from services.persona_shapes import fetch_root_personas, photo_ref

logger = logging.getLogger("caselab.cases")

ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."


def _authorize_case_access(owner_admin_id: str | None, admin: CurrentAdmin) -> None:
    """A case is visible/writable to the admin who owns it, or to any super
    admin. A ``NULL`` owner_admin_id (a legacy case predating per-admin
    ownership) is nobody's — visible only to super admins, per the plan's
    "no invented ownership" rule."""
    if admin.role == SUPER_ADMIN_ROLE:
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
# in 3 concurrent round-trips (not one recursive fetch per persona — a case
# with 6 roots each referring 2 personas used to mean ~54 sequential Turso
# round-trips), then _assemble_persona_tree walks root -> referral in memory
# over the pre-fetched maps. _assemble_persona_tree is a pure, synchronous
# function — it does no I/O — specifically so the recursive tree-walk stays as
# readable as the old per-persona-fetch version despite the data now being
# pre-fetched rather than queried on the way down.


def _assemble_persona_tree(
    persona_id: str,
    personas_by_id: dict[str, dict],
    files_by_persona: dict[str, list[dict]],
    referrals_by_parent: dict[str, list[dict]],
) -> dict:
    persona = personas_by_id.get(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="Persona not found.")
    profile_photo = photo_ref(persona, presign=False)
    files = [
        {
            "file": photo_ref(row, presign=False),
            "shareConditions": row["share_conditions"],
            "perceivedContents": row["perceived_contents"],
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
                "name": referred_persona["name"],
                "triggerType": row["trigger_type"],
                "conditions": row["condition_trigger"],
                "revealDelayMinutes": row["time_trigger"],
                "persona": referred_persona,
            }
        )
    return {
        "name": persona["name"],
        "role": persona["role"],
        "profilePhoto": profile_photo,
        "knownFacts": persona["known_facts"],
        "unknownFacts": persona["unknown_facts"],
        "hiddenFacts": persona["hidden_facts"],
        "personalityTraits": persona["personality_traits"],
        "scheduledAfterMinutes": persona["scheduled_time"] or None,
        "availabilityMinutes": persona["availability_duration"],
        "fileCount": len(files),
        "files": files,
        "referralOutCount": len(referrals),
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
    if payload.accessCode and await repo.access_code_taken(client, payload.accessCode):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    case_id = uuid.uuid4().hex
    try:
        statements = [repo.insert_case(case_id, payload, owner_admin_id=admin.id)]
        await save_case_structure(client, case_id, payload, statements)
        await client.batch(statements)
    except Exception as exc:
        # The batch is one atomic transaction (BEGIN...COMMIT/ROLLBACK), so a
        # failure here never leaves a partially-written case — no manual
        # rollback needed.
        if _is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        logger.exception("Failed to create case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to create case.") from exc
    return {"case_id": case_id}


async def list_cases(admin: CurrentAdmin) -> dict:
    client = get_db_client()
    # None (no filter) only for a super admin, who also sees legacy
    # NULL-owner cases that a plain owner_admin_id = ? filter would miss.
    owner_filter = None if admin.role == SUPER_ADMIN_ROLE else admin.id
    rows = await repo.fetch_cases(client, owner_admin_id=owner_filter)
    return {
        "cases": [
            {"id": row["id"], "case_name": row["case_name"], "access_code": row["access_code"]}
            for row in rows
        ]
    }


async def get_active_case() -> dict:
    client = get_db_client()
    case = await repo.fetch_first_case(client)
    if case is None:
        raise HTTPException(status_code=404, detail="No case found.")
    persona_rows = await fetch_root_personas(client, case["id"])
    personas = [
        {
            "id": row["id"],
            "name": row["name"],
            "role": row["role"],
            "profile_photo": photo_ref(row, presign=False),
            "scheduled_time": row["scheduled_time"],
            "availability_duration": row["availability_duration"],
        }
        for row in persona_rows
    ]
    return {
        "case": {
            "id": case["id"],
            "case_name": case["case_name"],
            "initial_brief": case["initial_brief"],
            "simulation_duration": case["simulation_duration"],
        },
        "personas": personas,
    }


async def get_case(case_id: str, admin: CurrentAdmin) -> dict:
    client = get_db_client()
    case = await repo.fetch_case(client, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="CaseForm not found.")
    _authorize_case_access(case["owner_admin_id"], admin)
    personas = await build_case_personas(client, case["id"])
    return {
        "case": {
            "id": case["id"],
            "caseName": case["case_name"],
            "accessCode": case["access_code"],
            "initialBrief": case["initial_brief"],
            "commonInformation": case["common_information"],
            "simulationDurationMinutes": case["simulation_duration"],
            "totalNonReferredPersonas": case["non_referred"],
            "personas": personas,
        }
    }


async def update_case(case_id: str, payload, admin: CurrentAdmin) -> dict:
    client = get_db_client()
    existing = await repo.fetch_case_owner(client, case_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="CaseForm not found.")
    _authorize_case_access(existing["owner_admin_id"], admin)
    if payload.accessCode and await repo.access_code_taken(
        client, payload.accessCode, exclude_case_id=case_id
    ):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    try:
        statements = [
            repo.update_case_fields(case_id, payload),
            repo.delete_personas_for_case(case_id),
        ]
        await save_case_structure(client, case_id, payload, statements)
        # One atomic transaction: the field update, the wipe, and every new
        # persona/file/referral insert either all commit or all roll back —
        # the old personas can never be gone with the new ones half-written.
        await client.batch(statements)
    except Exception as exc:
        if _is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        logger.exception("Failed to update case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to update case.") from exc
    return {"case_id": case_id}
