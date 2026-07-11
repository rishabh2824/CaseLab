"""Data access for the cases domain.

All SQL for cases / personas / files / referrals lives here. Reads execute
immediately and take the db client as their first argument, returning plain
dicts keyed by column name (via ``row.asdict()``), not positional tuples, so
callers aren't coupled to select-column order.

Writes to ``cases``/``personas``/``persona_files``/``persona_referrals`` are
BUILDERS, not executors: they return (or append to a caller-supplied list) the
``(sql, params)`` statement tuple(s) without touching the DB. The caller
(``case_service``) collects every statement for a create/update into one list
and runs it through ``client.batch(...)``, which the libsql HTTP client wraps
in a real BEGIN/COMMIT/ROLLBACK — so a whole case write is one atomic
transaction instead of a sequence of independently-committed statements that
can leave a case half-written if a later step fails.

``files`` rows are the one exception: ``get_or_create_file_id``/``insert_file``
still execute immediately, since a file's id must be known before it can be
embedded in a persona/persona_files statement. A failure after that point
rolls back the persona/case writes but leaves the file metadata row in place;
that's a harmless orphan (the file already exists in Spaces either way), not
data loss, so it doesn't need the same atomicity treatment.

Response shaping and domain logic live in the service/router layers.
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


def insert_case(case_id: str, payload, owner_admin_id: str | None) -> tuple[str, tuple]:
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
            _normalize_access_code(payload.access_code),
            payload.initial_brief,
            payload.common_information,
            payload.simulation_duration,
            payload.total_non_referred_personas,
            owner_admin_id,
        ),
    )


def update_case_fields(case_id: str, payload) -> tuple[str, tuple]:
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
            _normalize_access_code(payload.access_code),
            payload.initial_brief,
            payload.common_information,
            payload.simulation_duration,
            payload.total_non_referred_personas,
            case_id,
        ),
    )


def delete_personas_for_case(case_id: str) -> tuple[str, tuple]:
    return ("delete from personas where case_id = ?", (case_id,))


async def delete_case(client, case_id: str) -> None:
    # ON DELETE CASCADE (cases -> personas -> persona_files/persona_referrals)
    # only fires if foreign keys are enforced for *this* statement — same
    # PRAGMA-batched-with-the-DELETE requirement as admin_repository.delete
    # and update_case's persona wipe (see schema.txt for the FK chain).
    await client.batch(
        [
            ("PRAGMA foreign_keys = ON", ()),
            ("delete from cases where id = ?", (case_id,)),
        ]
    )


# --- cases: reads ----------------------------------------------------------


async def fetch_case_owner(client, case_id: str) -> dict | None:
    """Cheap lookup for authorization checks (create/update) that don't need
    the full case row — just whether it exists and who owns it."""
    result = await client.execute(
        "select id, owner_admin_id from cases where id = ?",
        (case_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None


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


async def fetch_cases(client, owner_admin_id: str | None = None) -> list[dict]:
    """List cases, optionally scoped to one owner. ``owner_admin_id=None``
    means "no filter" — the caller (case_service) only passes ``None`` for a
    super admin, who sees every case including legacy ``NULL``-owner ones."""
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
    return rows_to_dicts(result.rows)


async def fetch_case(client, case_id: str) -> dict | None:
    result = await client.execute(
        """
        select id, case_name, access_code, initial_brief, common_information,
               simulation_duration, non_referred, owner_admin_id
        from cases
        where id = ?
        """,
        (case_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None




async def fetch_personas_for_case(client, case_id: str) -> list[dict]:
    """Every persona (root + referred) belonging to a case, in one round-trip.
    Callers index this by ``id`` to assemble the persona tree in memory instead
    of fetching one persona at a time."""
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
               p.unknown_facts,
               p.hidden_facts,
               p.personality_traits,
               p.scheduled_time,
               p.availability_duration
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.case_id = ?
        """,
        (case_id,),
    )
    return rows_to_dicts(result.rows)


async def fetch_persona_files_for_case(client, case_id: str) -> list[dict]:
    """Every persona_files row for every persona in the case, in one
    round-trip. Callers index this by ``persona_id``."""
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
    return rows_to_dicts(result.rows)


async def fetch_referrals_for_case(client, case_id: str) -> list[dict]:
    """Every referral in the case, in one round-trip. Callers index this by
    ``parent_persona_id`` (and, to find root personas, collect every
    ``referred_persona_id``)."""
    result = await client.execute(
        """
        select parent_persona_id, referred_persona_id, trigger_type, condition_trigger, time_trigger
        from persona_referrals
        where case_id = ?
        """,
        (case_id,),
    )
    return rows_to_dicts(result.rows)


# --- files / personas / referrals: writes ----------------------------------


async def insert_file(client, file_ref) -> str:
    # upload_status has never varied in practice (there's no upload pipeline
    # that leaves it anything but 'uploaded') — leave the column for now
    # (YAGNI to drop it), but let its DB DEFAULT fill it in rather than
    # passing "uploaded" as a bound parameter as if this insert chooses it.
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


async def get_or_create_file_id(client, file_ref) -> str:
    result = await client.execute(
        "select id from files where bucket = ? and object_key = ?",
        (file_ref.bucket, file_ref.object_key),
    )
    if result.rows:
        return row_to_dict(result.rows[0])["id"]
    return await insert_file(client, file_ref)


async def insert_persona_files(
    client, persona_id: str, files: list[FileEntry], statements: list
) -> None:
    """Resolve each file's id (a live read/insert against ``files`` — see the
    module docstring) and append its persona_files insert statement to
    ``statements`` rather than executing it."""
    for entry in files:
        if not entry.file:
            continue
        file_id = await get_or_create_file_id(client, entry.file)
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
    client, case_id: str, persona: PersonaPayload, statements: list
) -> str:
    """Append this persona's insert statement (and its files' insert
    statements) to ``statements``; returns the persona_id the caller (e.g.
    ``insert_referrals``) needs to link a referral to it. The id is generated
    here, in Python, rather than left to the table's default, precisely so it
    can be referenced before the insert actually runs."""
    persona_id = uuid.uuid4().hex
    scheduled_time = persona.scheduled_after_minutes or 0
    profile_photo_file_id = None
    if persona.profile_photo:
        profile_photo_file_id = await get_or_create_file_id(client, persona.profile_photo)
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
                persona.known_facts,
                persona.unknown_facts,
                persona.hidden_facts,
                persona.personality_traits,
                scheduled_time,
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
        condition_trigger = (
            referral.conditions if referral.trigger_type == "conditions" else None
        )
        time_trigger = referral.reveal_delay_minutes if referral.trigger_type == "time" else None
        statements.append(
            (
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
                    referral.trigger_type,
                    condition_trigger,
                    time_trigger,
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
