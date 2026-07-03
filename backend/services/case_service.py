"""Case domain logic.

Orchestrates the repository reads/writes and shapes responses. Acquires the db
client so the router layer stays free of any data access. Holds no raw SQL.
"""

import logging
import uuid

import libsql_client
from fastapi import HTTPException

from services import case_repository as repo
from services.db import get_db_client

logger = logging.getLogger("caselab.cases")

ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."


def _is_unique_violation(exc: Exception) -> bool:
    """Whether exc looks like a UNIQUE constraint violation from the DB.

    Defense in depth for a race between the pre-check in create_case/
    update_case and the write itself; the partial UNIQUE index in
    migrations/0002 is the actual guarantee.
    """
    if not isinstance(exc, libsql_client.LibsqlError):
        return False
    return "UNIQUE" in (exc.code or "").upper() or "UNIQUE" in (exc.explanation or "").upper()


# --- persona assembly ------------------------------------------------------


async def build_persona_payload(client, persona_id: str) -> dict:
    persona = await repo.fetch_persona(client, persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="Persona not found.")
    profile_photo = (
        {
            "bucket": persona["bucket"],
            "object_key": persona["object_key"],
            "file_name": persona["file_name"],
            "content_type": persona["content_type"],
        }
        if persona["bucket"] and persona["object_key"] and persona["file_name"]
        else None
    )
    file_rows = await repo.fetch_persona_files(client, persona_id)
    files = [
        {
            "file": (
                {
                    "bucket": row["bucket"],
                    "object_key": row["object_key"],
                    "file_name": row["file_name"],
                    "content_type": row["content_type"],
                }
                if row["bucket"] and row["object_key"] and row["file_name"]
                else None
            ),
            "shareConditions": row["share_conditions"],
            "perceivedContents": row["perceived_contents"],
        }
        for row in file_rows
    ]
    referral_rows = await repo.fetch_persona_referrals(client, persona_id)
    referrals = []
    for row in referral_rows:
        referred_persona = await build_persona_payload(client, row["referred_persona_id"])
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


async def save_case_structure(client, case_id: str, payload) -> None:
    for persona in payload.personas:
        persona_id = await repo.insert_persona(client, case_id, persona)
        if persona.referrals:
            await repo.insert_referrals(client, case_id, persona_id, persona.referrals)


# --- operations (called by the router) -------------------------------------


async def create_case(payload) -> dict:
    client = get_db_client()
    if payload.accessCode and await repo.access_code_taken(client, payload.accessCode):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    case_id = uuid.uuid4().hex
    try:
        await repo.insert_case(client, case_id, payload)
        await save_case_structure(client, case_id, payload)
    except Exception as exc:
        try:
            await repo.delete_case(client, case_id)
        except Exception:
            logger.exception("Failed to roll back case %s after error", case_id)
        if _is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        logger.exception("Failed to create case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to create case.") from exc
    return {"case_id": case_id}


async def list_cases() -> dict:
    client = get_db_client()
    rows = await repo.fetch_cases(client)
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
    persona_rows = await repo.fetch_root_personas_with_photo(client, case["id"])
    personas = [
        {
            "id": row["id"],
            "name": row["name"],
            "role": row["role"],
            "profile_photo": (
                {
                    "bucket": row["bucket"],
                    "object_key": row["object_key"],
                    "file_name": row["file_name"],
                    "content_type": row["content_type"],
                }
                if row["bucket"] and row["object_key"] and row["file_name"]
                else None
            ),
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


async def get_case(case_id: str) -> dict:
    client = get_db_client()
    case = await repo.fetch_case(client, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    root_persona_ids = await repo.fetch_root_persona_ids(client, case["id"])
    personas = [
        await build_persona_payload(client, persona_id)
        for persona_id in root_persona_ids
    ]
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


async def update_case(case_id: str, payload) -> dict:
    client = get_db_client()
    if not await repo.case_exists(client, case_id):
        raise HTTPException(status_code=404, detail="Case not found.")
    if payload.accessCode and await repo.access_code_taken(
        client, payload.accessCode, exclude_case_id=case_id
    ):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    try:
        await repo.update_case_fields(client, case_id, payload)
        await repo.delete_personas_for_case(client, case_id)
        await save_case_structure(client, case_id, payload)
    except Exception as exc:
        if _is_unique_violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        logger.exception("Failed to update case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to update case.") from exc
    return {"case_id": case_id}
