from infra.db import rowToDict, rowsToDicts

PHOTO_COLUMNS = "photo.bucket, photo.object_key, photo.file_name, photo.content_type"
PERSONA_ROW_COLUMNS = f"p.id, p.name, p.role, {PHOTO_COLUMNS}, p.availability_duration"


async def fetch_root_personas(client, case_id: str) -> list[dict]:
    result = await client.execute(
        f"""
        select {PERSONA_ROW_COLUMNS}
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
    return rowsToDicts(result.rows)


async def fetch_case_snapshot(
    client, access_code: str | None = None, case_id: str | None = None
) -> dict | None:
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
    return rowToDict(result.rows[0]) if result.rows else None


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
    return rowToDict(result.rows[0]) if result.rows else None


async def fetch_persona_files(client, persona_id: str) -> list[dict]:
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
    return rowsToDicts(result.rows)


# Every referral edge for a case in one query (not scoped to one parent) — used to snapshot
# the whole persona graph once at /start rather than re-querying per parent on every turn.
async def fetch_all_referrals(client, case_id: str) -> list[dict]:
    result = await client.execute(
        f"""
        select pr.parent_persona_id, pr.referred_persona_id, pr.condition_trigger,
               {PERSONA_ROW_COLUMNS}
        from persona_referrals pr
        join personas p on p.id = pr.referred_persona_id
        left join files photo on photo.id = p.profile_photo_file_id
        where pr.case_id = ?
        """,
        (case_id,),
    )
    return rowsToDicts(result.rows)


