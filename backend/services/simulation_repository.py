"""Data access for the simulations domain (read-only queries).

Reads return plain dicts keyed by column name (via ``row.asdict()``), not
positional tuples, so callers aren't coupled to select-column order.
Presigned-URL generation and response shaping happen in ``simulation_service``.
"""

from services.db import row_to_dict, rows_to_dicts


async def fetch_case_snapshot(
    client, access_code: str | None = None, case_id: str | None = None
) -> dict | None:
    query = """
        select id, case_name, initial_brief, simulation_duration, common_information, access_code
        from cases
    """
    params = ()
    if case_id:
        query += " where id = ?"
        params = (case_id,)
    elif access_code:
        query += " where upper(access_code) = upper(?)"
        params = (access_code,)
    else:
        query += " limit 1"
    result = await client.execute(query, params)
    return row_to_dict(result.rows[0]) if result.rows else None


async def fetch_root_personas(client, case_id: str) -> list[dict]:
    result = await client.execute(
        """
        select p.id,
               p.name,
               p.role,
               photo.bucket,
               photo.object_key,
               photo.file_name,
               photo.content_type,
               p.scheduled_time,
               p.availability_duration
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.case_id = ?
          and p.id not in (
            select referred_persona_id
            from persona_referrals
            where case_id = ?
          )
        order by p.name
        """,
        (case_id, case_id),
    )
    return rows_to_dicts(result.rows)


async def fetch_persona_core(client, persona_id: str) -> dict | None:
    result = await client.execute(
        """
        select p.name,
               p.role,
               photo.bucket,
               photo.object_key,
               photo.file_name,
               photo.content_type,
               p.known_facts,
               p.unknown_facts,
               p.hidden_facts,
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
        select pr.referred_persona_id, pr.trigger_type, pr.condition_trigger, pr.time_trigger,
               p.name, p.role,
               photo.bucket, photo.object_key, photo.file_name, photo.content_type,
               p.scheduled_time, p.availability_duration
        from persona_referrals pr
        join personas p on p.id = pr.referred_persona_id
        left join files photo on photo.id = p.profile_photo_file_id
        where pr.case_id = ? and pr.parent_persona_id = ?
        """,
        (case_id, parent_persona_id),
    )
    return rows_to_dicts(result.rows)


async def fetch_personas_by_ids(client, ids) -> list[dict]:
    result = await client.execute(
        """
        select p.id,
               p.name,
               p.role,
               photo.bucket,
               photo.object_key,
               photo.file_name,
               photo.content_type,
               p.scheduled_time,
               p.availability_duration
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.id in ({})
        """.format(
            ",".join(["?"] * len(ids))
        ),
        tuple(ids),
    )
    return rows_to_dicts(result.rows)


async def fetch_persona_row(client, persona_id: str) -> dict | None:
    result = await client.execute(
        """
        select p.id,
               p.name,
               p.role,
               photo.bucket,
               photo.object_key,
               photo.file_name,
               photo.content_type,
               p.scheduled_time,
               p.availability_duration
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.id = ?
        """,
        (persona_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None
