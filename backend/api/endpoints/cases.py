import uuid

from fastapi import APIRouter, HTTPException

from backend.turso import get_db_client
from backend.schemas.cases import CasePayload, FileEntry, PersonaPayload, ReferralPayload

router = APIRouter(prefix="/cases", tags=["cases"])


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
    row = await client.execute(
        "select id from files where bucket = ? and object_key = ?",
        (file_ref.bucket, file_ref.object_key),
    )
    if row.rows:
        return row.rows[0][0]
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


async def insert_persona(
    client,
    case_id: str,
    persona: PersonaPayload,
) -> str:
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


async def build_persona_payload(client, persona_id: str) -> dict:
    persona_row = await client.execute(
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
    if not persona_row.rows:
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
    ) = persona_row.rows[0]
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
    file_rows = await client.execute(
        """
        select f.bucket, f.object_key, f.file_name, f.content_type,
               pf.share_conditions, pf.perceived_contents
        from persona_files pf
        left join files f on f.id = pf.file_id
        where pf.persona_id = ?
        """,
        (persona_id,),
    )
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
        ) in file_rows.rows
    ]
    referral_rows = await client.execute(
        """
        select referred_persona_id, trigger_type, condition_trigger, time_trigger
        from persona_referrals
        where parent_persona_id = ?
        """,
        (persona_id,),
    )
    referrals = []
    for referred_persona_id, trigger_type, condition_trigger, time_trigger in referral_rows.rows:
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


async def save_case_structure(client, case_id: str, payload: CasePayload) -> None:
    for persona in payload.personas:
        persona_id = await insert_persona(client, case_id, persona)
        if persona.referrals:
            await insert_referrals(client, case_id, persona_id, persona.referrals)


@router.post("")
async def create_case(payload: CasePayload):
    client = get_db_client()
    case_id = uuid.uuid4().hex
    try:
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
                payload.accessCode,
                payload.initialBrief,
                payload.commonInformation,
                payload.simulationDurationMinutes,
                payload.totalNonReferredPersonas,
            ),
        )
        await save_case_structure(client, case_id, payload)
    except Exception as exc:
        try:
            await client.execute("delete from cases where id = ?", (case_id,))
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"case_id": case_id}


@router.get("")
async def list_cases():
    client = get_db_client()
    rows = await client.execute(
        """
        select id, case_name, access_code
        from cases
        order by case_name
        """
    )
    return {
        "cases": [
            {"id": case_id, "case_name": case_name, "access_code": access_code}
            for case_id, case_name, access_code in rows.rows
        ]
    }


@router.get("/{case_id}")
async def get_case(case_id: str):
    client = get_db_client()
    case_row = await client.execute(
        """
        select id, case_name, access_code, initial_brief, common_information,
               simulation_duration, non_referred
        from cases
        where id = ?
        """,
        (case_id,),
    )
    if not case_row.rows:
        raise HTTPException(status_code=404, detail="Case not found.")
    (
        resolved_case_id,
        case_name,
        access_code,
        initial_brief,
        common_information,
        simulation_duration,
        non_referred,
    ) = case_row.rows[0]
    root_persona_rows = await client.execute(
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
        (resolved_case_id, resolved_case_id),
    )
    personas = [
        await build_persona_payload(client, persona_id)
        for (persona_id,) in root_persona_rows.rows
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


@router.put("/{case_id}")
async def update_case(case_id: str, payload: CasePayload):
    client = get_db_client()
    existing = await client.execute(
        "select id from cases where id = ?",
        (case_id,),
    )
    if not existing.rows:
        raise HTTPException(status_code=404, detail="Case not found.")
    try:
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
                payload.accessCode,
                payload.initialBrief,
                payload.commonInformation,
                payload.simulationDurationMinutes,
                payload.totalNonReferredPersonas,
                case_id,
            ),
        )
        await client.execute("delete from personas where case_id = ?", (case_id,))
        await save_case_structure(client, case_id, payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"case_id": case_id}


@router.get("/active")
async def get_active_case():
    client = get_db_client()
    row = await client.execute(
        """
        select id, case_name, initial_brief, simulation_duration
        from cases
        limit 1
        """
    )
    if not row.rows:
        raise HTTPException(status_code=404, detail="No case found.")
    case_id, case_name, initial_brief, simulation_duration = row.rows[0]
    persona_rows = await client.execute(
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
        ) in persona_rows.rows
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
