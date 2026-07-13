"""Data access for the simulations domain (read-only queries).

Reads return plain dicts keyed by column name (via ``row.asdict()``), not
positional tuples, so callers aren't coupled to select-column order.
Presigned-URL generation and response shaping happen in ``services.simulation.reads``.
"""

from services.db import row_to_dict, rows_to_dicts
from services.persona_shapes import PERSONA_ROW_COLUMNS, PHOTO_COLUMNS


async def fetch_case_snapshot(
    client, access_code: str | None = None, case_id: str | None = None
) -> dict | None:
    """Look up a case by exactly one of ``case_id`` or ``access_code`` — every
    caller supplies one of the two (see services.simulation.reads)."""
    if case_id:
        where, params = "where id = ?", (case_id,)
    elif access_code:
        where, params = "where upper(access_code) = upper(?)", (access_code,)
    else:
        raise ValueError("fetch_case_snapshot requires case_id or access_code.")
    result = await client.execute(
        f"""
        select id, case_name, initial_brief, simulation_duration, common_information, access_code
        from cases
        {where}
        """,
        params,
    )
    return row_to_dict(result.rows[0]) if result.rows else None


async def fetch_persona_core(client, persona_id: str) -> dict | None:
    result = await client.execute(
        f"""
        select p.name,
               p.role,
               {PHOTO_COLUMNS},
               p.known_facts,
               p.personality_traits
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.id = ?
        """,
        (persona_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None


async def fetch_persona_file_entries(client, persona_id: str) -> list[dict]:
    result = await client.execute(
        """
        select f.id, f.bucket, f.object_key, f.file_name, f.content_type,
               pf.share_conditions, pf.perceived_contents
        from persona_files pf
        left join files f on f.id = pf.file_id
        where pf.persona_id = ?
        """,
        (persona_id,),
    )
    return rows_to_dicts(result.rows)


async def fetch_referrals_for_parent(client, case_id: str, parent_persona_id: str) -> list[dict]:
    result = await client.execute(
        """
        select pr.referred_persona_id, pr.condition_trigger,
               p.name, p.role,
               photo.bucket, photo.object_key, photo.file_name, photo.content_type,
               p.availability_duration
        from persona_referrals pr
        join personas p on p.id = pr.referred_persona_id
        left join files photo on photo.id = p.profile_photo_file_id
        where pr.case_id = ? and pr.parent_persona_id = ?
        """,
        (case_id, parent_persona_id),
    )
    return rows_to_dicts(result.rows)


async def fetch_personas_by_ids(client, ids) -> list[dict]:
    placeholders = ",".join(["?"] * len(ids))
    result = await client.execute(
        f"""
        select {PERSONA_ROW_COLUMNS}
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.id in ({placeholders})
        """,
        tuple(ids),
    )
    return rows_to_dicts(result.rows)


async def fetch_persona_row(client, persona_id: str) -> dict | None:
    result = await client.execute(
        f"""
        select {PERSONA_ROW_COLUMNS}
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.id = ?
        """,
        (persona_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None
