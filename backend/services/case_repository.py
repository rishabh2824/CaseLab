"""Data access for the cases domain.

All SQL for cases / personas / files / referrals lives here. Functions take the
db client as their first argument. Reads return plain dicts keyed by column
name (via ``row.asdict()``), not positional tuples, so callers aren't coupled
to select-column order. Response shaping and domain logic live in the
service/router layers.
"""

import uuid

from models.cases import FileEntry, PersonaPayload, ReferralPayload
from services.db import row_to_dict, rows_to_dicts

# --- cases: writes ---------------------------------------------------------


def _normalize_access_code(access_code: str | None) -> str | None:
    """Treat a blank access code the same as "no code" (the frontend sends ''
    for an unset field, not null), so it doesn't collide with the partial
    UNIQUE index on upper(access_code) (see schema.txt)."""
    return access_code.strip() if access_code and access_code.strip() else None


async def insert_case(client, case_id: str, payload) -> None:
    await client.execute(
        """
        insert into cases (
            id,
            case_name,
            access_code,
            initial_brief,
            common_information,
            simulation_duration,
            non_referred
        )
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            case_id,
            payload.caseName,
            _normalize_access_code(payload.accessCode),
            payload.initialBrief,
            payload.commonInformation,
            payload.simulationDurationMinutes,
            payload.totalNonReferredPersonas,
        ),
    )


async def update_case_fields(client, case_id: str, payload) -> None:
    await client.execute(
        """
        update cases
        set case_name = ?,
            access_code = ?,
            initial_brief = ?,
            common_information = ?,
            simulation_duration = ?,
            non_referred = ?
        where id = ?
        """,
        (
            payload.caseName,
            _normalize_access_code(payload.accessCode),
            payload.initialBrief,
            payload.commonInformation,
            payload.simulationDurationMinutes,
            payload.totalNonReferredPersonas,
            case_id,
        ),
    )


async def delete_case(client, case_id: str) -> None:
    await client.execute("delete from cases where id = ?", (case_id,))


async def delete_personas_for_case(client, case_id: str) -> None:
    await client.execute("delete from personas where case_id = ?", (case_id,))


# --- cases: reads ----------------------------------------------------------


async def case_exists(client, case_id: str) -> bool:
    result = await client.execute(
        "select id from cases where id = ?",
        (case_id,),
    )
    return bool(result.rows)


async def access_code_taken(client, access_code: str, exclude_case_id: str | None = None) -> bool:
    """Whether another case already has this access code (case-insensitive).

    A quick pre-check for a friendly 409; the partial UNIQUE index
    (idx_cases_access_code_upper, see schema.txt) is the actual guarantee
    against a race between this check and the write.
    """
    normalized = _normalize_access_code(access_code)
    if normalized is None:
        return False
    result = await client.execute(
        """
        select id from cases
        where upper(access_code) = upper(?)
          and (? is null or id != ?)
        """,
        (normalized, exclude_case_id, exclude_case_id),
    )
    return bool(result.rows)


async def fetch_cases(client) -> list[dict]:
    result = await client.execute(
        """
        select id, case_name, access_code
        from cases
        order by case_name
        """
    )
    return rows_to_dicts(result.rows)


async def fetch_case(client, case_id: str) -> dict | None:
    result = await client.execute(
        """
        select id, case_name, access_code, initial_brief, common_information,
               simulation_duration, non_referred
        from cases
        where id = ?
        """,
        (case_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None


async def fetch_first_case(client) -> dict | None:
    result = await client.execute(
        """
        select id, case_name, initial_brief, simulation_duration
        from cases
        limit 1
        """
    )
    return row_to_dict(result.rows[0]) if result.rows else None


async def fetch_root_persona_ids(client, case_id: str) -> list[str]:
    result = await client.execute(
        """
        select p.id
        from personas p
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
    return [row["id"] for row in result.rows]


async def fetch_root_personas_with_photo(client, case_id: str) -> list[dict]:
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


async def fetch_persona(client, persona_id: str) -> dict | None:
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
               p.personality_traits,
               p.scheduled_time,
               p.availability_duration
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.id = ?
        """,
        (persona_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None


async def fetch_persona_files(client, persona_id: str) -> list[dict]:
    result = await client.execute(
        """
        select f.bucket, f.object_key, f.file_name, f.content_type,
               pf.share_conditions, pf.perceived_contents
        from persona_files pf
        left join files f on f.id = pf.file_id
        where pf.persona_id = ?
        """,
        (persona_id,),
    )
    return rows_to_dicts(result.rows)


async def fetch_persona_referrals(client, persona_id: str) -> list[dict]:
    result = await client.execute(
        """
        select referred_persona_id, trigger_type, condition_trigger, time_trigger
        from persona_referrals
        where parent_persona_id = ?
        """,
        (persona_id,),
    )
    return rows_to_dicts(result.rows)


# --- files / personas / referrals: writes ----------------------------------


async def insert_file(client, file_ref) -> str:
    file_id = uuid.uuid4().hex
    await client.execute(
        """
        insert into files (id, bucket, object_key, file_name, content_type, upload_status)
        values (?, ?, ?, ?, ?, ?)
        """,
        (
            file_id,
            file_ref.bucket,
            file_ref.object_key,
            file_ref.file_name,
            file_ref.content_type,
            "uploaded",
        ),
    )
    return file_id


async def get_or_create_file_id(client, file_ref) -> str:
    result = await client.execute(
        "select id from files where bucket = ? and object_key = ?",
        (file_ref.bucket, file_ref.object_key),
    )
    if result.rows:
        return row_to_dict(result.rows[0])["id"]
    return await insert_file(client, file_ref)


async def insert_persona_files(client, persona_id: str, files: list[FileEntry]) -> None:
    for entry in files:
        if not entry.file:
            continue
        file_id = await get_or_create_file_id(client, entry.file)
        await client.execute(
            """
            insert into persona_files (id, persona_id, file_id, share_conditions, perceived_contents)
            values (?, ?, ?, ?, ?)
            """,
            (
                uuid.uuid4().hex,
                persona_id,
                file_id,
                entry.shareConditions,
                entry.perceivedContents,
            ),
        )


async def insert_persona(client, case_id: str, persona: PersonaPayload) -> str:
    persona_id = uuid.uuid4().hex
    scheduled_time = persona.scheduledAfterMinutes or 0
    profile_photo_file_id = None
    if persona.profilePhoto:
        profile_photo_file_id = await get_or_create_file_id(client, persona.profilePhoto)
    await client.execute(
        """
        insert into personas (
            id,
            case_id,
            name,
            role,
            profile_photo_file_id,
            known_facts,
            unknown_facts,
            hidden_facts,
            personality_traits,
            scheduled_time,
            availability_duration
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            persona_id,
            case_id,
            persona.name,
            persona.role,
            profile_photo_file_id,
            persona.knownFacts,
            persona.unknownFacts,
            persona.hiddenFacts,
            persona.personalityTraits,
            scheduled_time,
            persona.availabilityMinutes,
        ),
    )
    await insert_persona_files(client, persona_id, persona.files)
    return persona_id


async def insert_referrals(
    client,
    case_id: str,
    parent_persona_id: str,
    referrals: list[ReferralPayload],
) -> None:
    for referral in referrals:
        referred_persona_id = await insert_persona(client, case_id, referral.persona)
        condition_trigger = (
            referral.conditions if referral.triggerType == "conditions" else None
        )
        time_trigger = referral.revealDelayMinutes if referral.triggerType == "time" else None
        await client.execute(
            """
            insert into persona_referrals (
                id,
                case_id,
                parent_persona_id,
                referred_persona_id,
                trigger_type,
                condition_trigger,
                time_trigger
            )
            values (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                uuid.uuid4().hex,
                case_id,
                parent_persona_id,
                referred_persona_id,
                referral.triggerType,
                condition_trigger,
                time_trigger,
            ),
        )
        if referral.persona.referrals:
            await insert_referrals(
                client,
                case_id,
                referred_persona_id,
                referral.persona.referrals,
            )
