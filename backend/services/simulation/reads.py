"""Persona / case reads: repository rows shaped into the dicts the rest of the
simulation engine and the API responses expect (profile-photo presigning,
nested referral personas, etc.)."""

import asyncio

from fastapi import HTTPException

from services.persona_shapes import fetch_root_personas, photo_ref
from services.simulation import repository as repo


def _format_persona_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "profile_photo": photo_ref(row, presign=True),
        "scheduled_time": row["scheduled_time"],
        "availability_duration": row["availability_duration"],
    }


async def _get_case_snapshot(client, access_code: str | None = None, case_id: str | None = None):
    row = await repo.fetch_case_snapshot(client, access_code=access_code, case_id=case_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No case found.")
    return {
        "id": row["id"],
        "case_name": row["case_name"],
        "initial_brief": row["initial_brief"],
        "simulation_duration": row["simulation_duration"],
        "common_information": row["common_information"],
        "access_code": row["access_code"],
    }


async def _get_run_case_snapshot(run: dict, client):
    """CaseForm snapshot for a run, cached on the run.

    The case is fixed for the life of a run, so re-querying it on every message
    is wasted work. The snapshot holds no presigned URLs, so caching it is safe
    (unlike persona/file rows, whose URLs expire and are re-signed each read).
    """
    cached = run.get("case_snapshot")
    if cached is not None:
        return cached
    snapshot = await _get_case_snapshot(client, case_id=run["case_id"])
    run["case_snapshot"] = snapshot
    return snapshot


async def _get_root_personas(client, case_id):
    rows = await fetch_root_personas(client, case_id)
    return [_format_persona_row(row) for row in rows]


async def _get_persona_details(client, persona_id):
    # The two reads are independent; run them as concurrent HTTP requests.
    persona, files = await asyncio.gather(
        repo.fetch_persona_core(client, persona_id),
        repo.fetch_persona_file_entries(client, persona_id),
    )
    if persona is None:
        raise HTTPException(status_code=404, detail="Persona not found.")
    file_entries = [
        {
            "file_id": row["id"],
            "bucket": row["bucket"],
            "object_key": row["object_key"],
            "file_name": row["file_name"],
            "content_type": row["content_type"],
            "share_conditions": row["share_conditions"],
            "perceived_contents": row["perceived_contents"],
        }
        for row in files
    ]
    return {
        "name": persona["name"],
        "role": persona["role"],
        "profile_photo": photo_ref(persona, presign=True),
        "known_facts": persona["known_facts"],
        "unknown_facts": persona["unknown_facts"],
        "hidden_facts": persona["hidden_facts"],
        "personality_traits": persona["personality_traits"],
        "files": file_entries,
    }


async def _get_referrals_for_parent(client, case_id, parent_persona_id):
    rows = await repo.fetch_referrals_for_parent(client, case_id, parent_persona_id)
    referrals = []
    for row in rows:
        referred_persona_id = row["referred_persona_id"]
        referrals.append(
            {
                "referred_persona_id": referred_persona_id,
                "trigger_type": row["trigger_type"],
                "condition_trigger": row["condition_trigger"] or "",
                "time_trigger": row["time_trigger"],
                "persona": {
                    "id": referred_persona_id,
                    "name": row["name"],
                    "role": row["role"],
                    "profile_photo": photo_ref(row, presign=True),
                    "scheduled_time": row["scheduled_time"],
                    "availability_duration": row["availability_duration"],
                    "is_referred": True,
                },
            }
        )
    return referrals
