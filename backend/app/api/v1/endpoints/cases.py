import uuid

from fastapi import APIRouter, HTTPException

from app.db.turso import get_db_client
from app.schemas.cases import CasePayload, FileEntry, PersonaPayload, ReferralPayload

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
    await client.execute(
        """
        insert into personas (
            id,
            case_id,
            name,
            role,
            known_facts,
            unknown_facts,
            hidden_facts,
            personality_traits,
            scheduled_time,
            availability_duration
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            persona_id,
            case_id,
            persona.name,
            persona.role,
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
                initial_brief,
                common_information,
                simulation_duration,
                non_referred
            )
            values (?, ?, ?, ?, ?, ?)
            """,
            (
                case_id,
                payload.caseName,
                payload.initialBrief,
                payload.commonInformation,
                payload.simulationDurationMinutes,
                payload.totalNonReferredPersonas,
            ),
        )
        for persona in payload.personas:
            persona_id = await insert_persona(client, case_id, persona)
            if persona.referrals:
                await insert_referrals(client, case_id, persona_id, persona.referrals)
    except Exception as exc:
        try:
            await client.execute("delete from cases where id = ?", (case_id,))
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"case_id": case_id}
