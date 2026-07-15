#Data access for the cases domain.

import uuid
from models.cases import FileEntry, PersonaPayload, ReferralPayload
from infra.db import rowToDict, rowsToDicts


# --- cases: writes ---------------------------------------------------------
def normalize_access_code(access_code: str | None) -> str | None:
    return access_code.strip() if access_code and access_code.strip() else None


def insertCase(case_id: str, payload, owner_admin_id: str) -> tuple[str, tuple]:
    return (
        """
        insert into cases (
            id,
            case_name,
            access_code,
            initial_brief,
            common_information,
            simulation_duration,
            non_referred,
            owner_admin_id
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            case_id,
            payload.case_name,
            normalize_access_code(payload.access_code),
            payload.initial_brief,
            payload.common_information,
            payload.simulation_duration,
            payload.total_non_referred_personas,
            owner_admin_id,
        ),
    )


def updateCase(case_id: str, payload) -> tuple[str, tuple]:
    return (
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
            payload.case_name,
            normalize_access_code(payload.access_code),
            payload.initial_brief,
            payload.common_information,
            payload.simulation_duration,
            payload.total_non_referred_personas,
            case_id,
        ),
    )


def deletePersona(case_id: str) -> tuple[str, tuple]:
    return "delete from personas where case_id = ?", (case_id,)


async def deleteCase(client, case_id: str) -> None:
    await client.batch(
        [
            ("PRAGMA foreign_keys = ON", ()),
            ("delete from cases where id = ?", (case_id,)),
        ]
    )


# --- cases: reads ----------------------------------------------------------
async def fetchCaseOwner(client, case_id: str) -> dict | None:
    result = await client.execute("select id, owner_admin_id from cases where id = ?", (case_id,),)
    return rowToDict(result.rows[0]) if result.rows else None


async def accessCodeTaken(client, access_code: str, exclude_case_id: str | None = None) -> bool:
    normalized = normalize_access_code(access_code)
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


async def fetchCases(client, owner_admin_id: str | None = None) -> list[dict]:
    if owner_admin_id is None:
        result = await client.execute(
            """
            select id, case_name, access_code
            from cases
            order by case_name
            """
        )
    else:
        result = await client.execute(
            """
            select id, case_name, access_code
            from cases
            where owner_admin_id = ?
            order by case_name
            """,
            (owner_admin_id,),
        )
    return rowsToDicts(result.rows)


async def fetchCase(client, case_id: str) -> dict | None:
    result = await client.execute(
        """
        select id, case_name, access_code, initial_brief, common_information,
               simulation_duration, non_referred, owner_admin_id
        from cases
        where id = ?
        """,
        (case_id,),
    )
    return rowToDict(result.rows[0]) if result.rows else None


async def fetchPersonas(client, case_id: str) -> list[dict]:
    result = await client.execute(
        """
        select p.id,
               p.name,
               p.role,
               photo.bucket,
               photo.object_key,
               photo.file_name,
               photo.content_type,
               p.known_facts,
               p.personality_traits,
               p.availability_duration
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.case_id = ?
        """,
        (case_id,),
    )
    return rowsToDicts(result.rows)


async def fetch_persona_files(client, case_id: str) -> list[dict]:
    result = await client.execute(
        """
        select pf.persona_id,
               f.bucket, f.object_key, f.file_name, f.content_type,
               pf.share_conditions, pf.perceived_contents
        from persona_files pf
        join personas p on p.id = pf.persona_id
        left join files f on f.id = pf.file_id
        where p.case_id = ?
        """,
        (case_id,),
    )
    return rowsToDicts(result.rows)


async def fetch_referrals(client, case_id: str) -> list[dict]:
    result = await client.execute(
        """
        select parent_persona_id, referred_persona_id, condition_trigger
        from persona_referrals
        where case_id = ?
        """,
        (case_id,),
    )
    return rowsToDicts(result.rows)


# --- files / personas / referrals: writes ----------------------------------
async def insert_file(client, file_ref) -> str:
    file_id = uuid.uuid4().hex
    await client.execute(
        """
        insert into files (id, bucket, object_key, file_name, content_type)
        values (?, ?, ?, ?, ?)
        """,
        (
            file_id,
            file_ref.bucket,
            file_ref.object_key,
            file_ref.file_name,
            file_ref.content_type,
        ),
    )
    return file_id


async def get_file_id(client, file_ref) -> str:
    result = await client.execute(
        "select id from files where bucket = ? and object_key = ?",
        (file_ref.bucket, file_ref.object_key),
    )
    if result.rows:
        row_dict = rowToDict(result.rows[0])
        if row_dict: return row_dict["id"]

    return await insert_file(client, file_ref)


async def insert_persona_files(client, persona_id: str, files: list[FileEntry], statements: list) -> None:
    for entry in files:
        if not entry.file:
            continue
        file_id = await get_file_id(client, entry.file)
        statements.append(
            (
                """
                insert into persona_files (id, persona_id, file_id, share_conditions, perceived_contents)
                values (?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    persona_id,
                    file_id,
                    entry.share_conditions,
                    entry.perceived_contents,
                ),
            )
        )


async def insert_persona(
    client, case_id: str, persona: PersonaPayload, statements: list) -> str:
    persona_id = uuid.uuid4().hex
    profile_photo_file_id = None
    if persona.profile_photo:
        profile_photo_file_id = await get_file_id(client, persona.profile_photo)
    statements.append(
        (
            """
            insert into personas (
                id,
                case_id,
                name,
                role,
                profile_photo_file_id,
                known_facts,
                personality_traits,
                availability_duration
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                persona_id,
                case_id,
                persona.name,
                persona.role,
                profile_photo_file_id,
                persona.known_facts,
                persona.personality_traits,
                persona.availability_minutes,
            ),
        )
    )
    await insert_persona_files(client, persona_id, persona.files, statements)
    return persona_id


async def insert_referrals(
    client,
    case_id: str,
    parent_persona_id: str,
    referrals: list[ReferralPayload],
    statements: list,
) -> None:
    for referral in referrals:
        referred_persona_id = await insert_persona(client, case_id, referral.persona, statements)
        statements.append(
            (
                """
                insert into persona_referrals (
                    id,
                    case_id,
                    parent_persona_id,
                    referred_persona_id,
                    condition_trigger
                )
                values (?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    case_id,
                    parent_persona_id,
                    referred_persona_id,
                    referral.conditions,
                ),
            )
        )
        if referral.persona.referrals:
            await insert_referrals(
                client,
                case_id,
                referred_persona_id,
                referral.persona.referrals,
                statements,
            )
