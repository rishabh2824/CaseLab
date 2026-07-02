"""Case domain logic.

Orchestrates the repository reads/writes and shapes responses. Acquires the db
client so the router layer stays free of any data access. Holds no raw SQL.
"""

import logging
import uuid

from fastapi import HTTPException

from services import case_repository as repo
from services.db import get_db_client

logger = logging.getLogger("caselab.cases")


# --- persona assembly ------------------------------------------------------


async def build_persona_payload(client, persona_id: str) -> dict:
    persona = await repo.fetch_persona(client, persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="Persona not found.")
    (
        name,
        role,
        photo_bucket,
        photo_object_key,
        photo_file_name,
        photo_content_type,
        known_facts,
        unknown_facts,
        hidden_facts,
        personality_traits,
        scheduled_time,
        availability_duration,
    ) = persona
    profile_photo = (
        {
            "bucket": photo_bucket,
            "object_key": photo_object_key,
            "file_name": photo_file_name,
            "content_type": photo_content_type,
        }
        if photo_bucket and photo_object_key and photo_file_name
        else None
    )
    file_rows = await repo.fetch_persona_files(client, persona_id)
    files = [
        {
            "file": (
                {
                    "bucket": bucket,
                    "object_key": object_key,
                    "file_name": file_name,
                    "content_type": content_type,
                }
                if bucket and object_key and file_name
                else None
            ),
            "shareConditions": share_conditions,
            "perceivedContents": perceived_contents,
        }
        for (
            bucket,
            object_key,
            file_name,
            content_type,
            share_conditions,
            perceived_contents,
        ) in file_rows
    ]
    referral_rows = await repo.fetch_persona_referrals(client, persona_id)
    referrals = []
    for referred_persona_id, trigger_type, condition_trigger, time_trigger in referral_rows:
        referred_persona = await build_persona_payload(client, referred_persona_id)
        referrals.append(
            {
                "name": referred_persona["name"],
                "triggerType": trigger_type,
                "conditions": condition_trigger,
                "revealDelayMinutes": time_trigger,
                "persona": referred_persona,
            }
        )
    return {
        "name": name,
        "role": role,
        "profilePhoto": profile_photo,
        "knownFacts": known_facts,
        "unknownFacts": unknown_facts,
        "hiddenFacts": hidden_facts,
        "personalityTraits": personality_traits,
        "scheduledAfterMinutes": scheduled_time or None,
        "availabilityMinutes": availability_duration,
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
    case_id = uuid.uuid4().hex
    try:
        await repo.insert_case(client, case_id, payload)
        await save_case_structure(client, case_id, payload)
    except Exception as exc:
        try:
            await repo.delete_case(client, case_id)
        except Exception:
            logger.exception("Failed to roll back case %s after error", case_id)
        logger.exception("Failed to create case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to create case.") from exc
    return {"case_id": case_id}


async def list_cases() -> dict:
    client = get_db_client()
    rows = await repo.fetch_cases(client)
    return {
        "cases": [
            {"id": case_id, "case_name": case_name, "access_code": access_code}
            for case_id, case_name, access_code in rows
        ]
    }


async def get_active_case() -> dict:
    client = get_db_client()
    row = await repo.fetch_first_case(client)
    if row is None:
        raise HTTPException(status_code=404, detail="No case found.")
    case_id, case_name, initial_brief, simulation_duration = row
    persona_rows = await repo.fetch_root_personas_with_photo(client, case_id)
    personas = [
        {
            "id": p_id,
            "name": name,
            "role": role,
            "profile_photo": (
                {
                    "bucket": photo_bucket,
                    "object_key": photo_object_key,
                    "file_name": photo_file_name,
                    "content_type": photo_content_type,
                }
                if photo_bucket and photo_object_key and photo_file_name
                else None
            ),
            "scheduled_time": scheduled_time,
            "availability_duration": availability_duration,
        }
        for (
            p_id,
            name,
            role,
            photo_bucket,
            photo_object_key,
            photo_file_name,
            photo_content_type,
            scheduled_time,
            availability_duration,
        ) in persona_rows
    ]
    return {
        "case": {
            "id": case_id,
            "case_name": case_name,
            "initial_brief": initial_brief,
            "simulation_duration": simulation_duration,
        },
        "personas": personas,
    }


async def get_case(case_id: str) -> dict:
    client = get_db_client()
    row = await repo.fetch_case(client, case_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    (
        resolved_case_id,
        case_name,
        access_code,
        initial_brief,
        common_information,
        simulation_duration,
        non_referred,
    ) = row
    root_persona_rows = await repo.fetch_root_persona_ids(client, resolved_case_id)
    personas = [
        await build_persona_payload(client, persona_id)
        for (persona_id,) in root_persona_rows
    ]
    return {
        "case": {
            "id": resolved_case_id,
            "caseName": case_name,
            "accessCode": access_code,
            "initialBrief": initial_brief,
            "commonInformation": common_information,
            "simulationDurationMinutes": simulation_duration,
            "totalNonReferredPersonas": non_referred,
            "personas": personas,
        }
    }


async def update_case(case_id: str, payload) -> dict:
    client = get_db_client()
    if not await repo.case_exists(client, case_id):
        raise HTTPException(status_code=404, detail="Case not found.")
    try:
        await repo.update_case_fields(client, case_id, payload)
        await repo.delete_personas_for_case(client, case_id)
        await save_case_structure(client, case_id, payload)
    except Exception as exc:
        logger.exception("Failed to update case %s", case_id)
        raise HTTPException(status_code=500, detail="Failed to update case.") from exc
    return {"case_id": case_id}
