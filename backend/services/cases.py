import asyncio
import uuid
from collections import defaultdict
import libsql_client
from fastapi import HTTPException
from models.admin import AdminRole
from Queries import cases as repo
from services.admin_auth import CurrentAdmin
from infra.db import getDb
from services.persona_shapes import photo_ref


ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."


def authorize_case_access(owner_admin_id: str, admin: CurrentAdmin) -> None:
    if admin.role == AdminRole.SUPER: return
    if owner_admin_id != admin.id: raise HTTPException(status_code=403, detail="You do not have access to this case.")


#Whether exc looks like a UNIQUE constraint violation from the DB
def is_unique_violation(exc: Exception) -> bool:
    if not isinstance(exc, libsql_client.LibsqlError): return False
    return "UNIQUE" in (exc.code or "").upper() or "UNIQUE" in (exc.explanation or "").upper()


#Fetches every persona/file/referral belonging to a case in 3 concurrent round-trips
def assemble_persona_tree(
    persona_id: str,
    personas_by_id: dict[str, dict],
    files_by_persona: dict[str, list[dict]],
    referrals_by_parent: dict[str, list[dict]],
) -> dict:
    persona = personas_by_id.get(persona_id)
    if persona is None:
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
        # noinspection PyTypeChecker
        referred_persona = assemble_persona_tree(
            row["referred_persona_id"], personas_by_id, files_by_persona, referrals_by_parent
        )
        referrals.append(
            {
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
        "file_count": len(files),
        "files": files,
        "referral_out_count": len(referrals),
        "referrals": referrals,
    }


async def build_case_personas(client, case_id: str) -> list[dict]:
    personas, files, referrals = await asyncio.gather(
        repo.fetchPersonas(client, case_id),
        repo.fetch_persona_files(client, case_id),
        repo.fetch_referrals(client, case_id),
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
        assemble_persona_tree(persona_id, personas_by_id, files_by_persona, referrals_by_parent)
        for persona_id in root_ids
    ]


async def save_case_structure(client, case_id: str, payload, statements: list) -> None:
    for persona in payload.personas:
        persona_id = await repo.insert_persona(client, case_id, persona, statements)
        if persona.referrals:
            await repo.insert_referrals(client, case_id, persona_id, persona.referrals, statements)


async def create_case(payload, admin: CurrentAdmin) -> dict:
    client = getDb()
    if payload.access_code and await repo.accessCodeTaken(client, payload.access_code):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    case_id = uuid.uuid4().hex
    try:
        statements = [repo.insertCase(case_id, payload, owner_admin_id=admin.id)]
        await save_case_structure(client, case_id, payload, statements)
        await client.batch(statements)
    except Exception as exc:
        if is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        raise HTTPException(status_code=500, detail="Failed to create case.") from exc
    return {"case_id": case_id}


async def list_cases(admin: CurrentAdmin) -> dict:
    client = getDb()
    owner_filter = None if admin.role == AdminRole.SUPER else admin.id
    rows = await repo.fetchCases(client, owner_admin_id=owner_filter)
    return {
        "cases": [
            {"id": row["id"], "case_name": row["case_name"], "access_code": row["access_code"]}
            for row in rows
        ]
    }


async def get_case(case_id: str, admin: CurrentAdmin) -> dict:
    client = getDb()
    case = await repo.fetchCase(client, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    authorize_case_access(case["owner_admin_id"], admin)
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
    client = getDb()
    existing = await repo.fetchCaseOwner(client, case_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    authorize_case_access(existing["owner_admin_id"], admin)
    if payload.access_code and await repo.accessCodeTaken(
        client, payload.access_code, exclude_case_id=case_id
    ):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    try:
        statements = [
            ("PRAGMA foreign_keys = ON", ()),
            repo.updateCase(case_id, payload),
            repo.deletePersona(case_id),
        ]
        await save_case_structure(client, case_id, payload, statements)
        await client.batch(statements)
    except Exception as exc:
        if is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        raise HTTPException(status_code=500, detail="Failed to update case.") from exc
    return {"case_id": case_id}


async def delete_case(case_id: str, admin: CurrentAdmin) -> dict:
    client = getDb()
    existing = await repo.fetchCaseOwner(client, case_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    authorize_case_access(existing["owner_admin_id"], admin)
    await repo.deleteCase(client, case_id)
    return {"ok": True}
