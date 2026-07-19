import uuid
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException
from sqlmodel import select
from models.admin import AdminRole
from models.cases import CasePayload, FileRef, PersonaPayload
from services.auth import CurrentAdmin
from infra.db import get_session
from infra.db_models import Case, File


ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."


# Authorize access to a case
def caseAccess(owner_admin_id: int, admin: CurrentAdmin) -> None:
    if admin.role == AdminRole.SUPER: return
    if owner_admin_id != admin.id: raise HTTPException(status_code=403, detail="You do not have access to this case.")


# Whether exc looks like a UNIQUE constraint violation from Postgres
def violation(exc: Exception) -> bool:
    if not isinstance(exc, IntegrityError): return False
    return getattr(exc.orig, "sqlstate", None) == "23505"


# Normalizes a file record down to just the fields needed to display it
def normalizeFile(entry: dict | None) -> dict | None:
    if not entry: return None
    return {
        "bucket": entry["bucket"],
        "object_key": entry["object_key"],
        "file_name": entry["file_name"],
        "content_type": entry.get("content_type"),
    }


# Takes the root persona and produces a fully expanded tree
def adminTree(persona: dict) -> dict:
    files = [
        {
            "file": normalizeFile(f.get("file")),
            "share_conditions": f.get("share_conditions"),
            "perceived_contents": f.get("perceived_contents"),
        }
        for f in persona.get("files") or []
    ]
    referrals = []
    for referral in persona.get("referrals") or []:
        referred_persona = adminTree(referral["persona"])
        referrals.append(
            {"name": referred_persona["name"], "conditions": referral.get("conditions"), "persona": referred_persona}
        )
    return {
        "name": persona.get("name") or "",
        "role": persona.get("role") or "",
        "profile_photo": normalizeFile(persona.get("profile_photo")),
        "known_facts": persona.get("known_facts"),
        "personality_traits": persona.get("personality_traits"),
        "availability_minutes": persona.get("availability_minutes"),
        "file_count": len(files),
        "files": files,
        "referral_out_count": len(referrals),
        "referrals": referrals,
    }


# whitespace case mismatches
def normalizeAccessCode(access_code: str | None) -> str | None:
    return access_code.strip() if access_code and access_code.strip() else None


async def accessCodeTaken(session, access_code: str, exclude_case_id: int | None = None) -> bool:
    stmt = select(Case.id).where(Case.access_code == access_code)
    if exclude_case_id:
        stmt = stmt.where(Case.id != exclude_case_id)
    result = await session.exec(stmt)
    return result.first() is not None


# --- file dedup: get-or-create by (bucket, object_key), same as the old get_file_id ----
async def resolve_file_ref(session, file_ref: FileRef | None) -> dict | None:
    if file_ref is None:
        return None
    file_row = (
        await session.exec(
            select(File).where(File.bucket == file_ref.bucket, File.object_key == file_ref.object_key)
        )
    ).first()
    if file_row is None:
        file_row = File(
            bucket=file_ref.bucket,
            object_key=file_ref.object_key,
            name=file_ref.file_name,
            content_type=file_ref.content_type,
        )
        session.add(file_row)
        await session.flush()  # assigns file_row.id without committing the outer transaction
    return {
        # Stringified even though the column is now a plain int id — this dict lands
        # inside the JSONB structure/run blobs, where file_id also serves as a dict
        # key (see run["shared_files"][file_id] in services/simulation/service.py);
        # JSON silently stringifies int dict keys on serialization, so keeping it a
        # string from the start avoids an int-vs-str mismatch after a round-trip.
        "file_id": str(file_row.id),
        "bucket": file_row.bucket,
        "object_key": file_row.object_key,
        "file_name": file_row.name,
        "content_type": file_row.content_type,
    }


async def build_persona_dict(session, persona: PersonaPayload) -> dict:
    files = []
    for entry in persona.files:
        if not entry.file:
            continue
        files.append(
            {
                "file": await resolve_file_ref(session, entry.file),
                "share_conditions": entry.share_conditions,
                "perceived_contents": entry.perceived_contents,
            }
        )
    referrals = [
        {"conditions": referral.conditions, "persona": await build_persona_dict(session, referral.persona)}
        for referral in persona.referrals
    ]
    return {
        # Regenerated on every save, same as the old delete-and-reinsert behavior — an
        # in-flight simulation run has already cached its own persona_graph snapshot by
        # the time a case is edited, so it never observes these ids changing mid-run.
        "id": uuid.uuid4().hex,
        "name": persona.name,
        "role": persona.role,
        "profile_photo": await resolve_file_ref(session, persona.profile_photo),
        "known_facts": persona.known_facts,
        "personality_traits": persona.personality_traits,
        "availability_minutes": persona.availability_minutes,
        "files": files,
        "referrals": referrals,
    }


async def build_structure(session, payload: CasePayload) -> dict:
    return {"personas": [await build_persona_dict(session, p) for p in payload.personas]}


async def fetchCases(session, owner_admin_id: int | None = None) -> list[Case]:
    stmt = select(Case).order_by(Case.name)
    if owner_admin_id is not None:
        stmt = stmt.where(Case.admin == owner_admin_id)
    return (await session.exec(stmt)).all()


async def createCase(payload, admin: CurrentAdmin) -> dict:
    async with get_session() as session:
        normalized_code = normalizeAccessCode(payload.access_code)
        if normalized_code and await accessCodeTaken(session, normalized_code):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
        case = Case(
            name=payload.case_name,
            access_code=normalized_code,
            brief=payload.initial_brief,
            common_information=payload.common_information,
            duration=payload.simulation_duration,
            root_personas=payload.total_non_referred_personas,
            admin=admin.id,
            structure=await build_structure(session, payload),
        )
        session.add(case)
        try:
            await session.commit()
        except Exception as exc:
            await session.rollback()
            if violation(exc):
                raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
            raise HTTPException(status_code=500, detail="Failed to create case.") from exc
        return {"case_id": case.id}


async def listCases(admin: CurrentAdmin) -> dict:
    async with get_session() as session:
        owner_filter = None if admin.role == AdminRole.SUPER else admin.id
        cases = await fetchCases(session, owner_admin_id=owner_filter)
    return {
        "cases": [
            {"id": case.id, "case_name": case.name, "access_code": case.access_code} for case in cases
        ]
    }


async def getCase(case_id: int, admin: CurrentAdmin) -> dict:
    async with get_session() as session:
        case = await session.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    caseAccess(case.admin, admin)
    personas = [adminTree(p) for p in (case.structure.get("personas") or [])]
    return {
        "case": {
            "id": case.id,
            "case_name": case.name,
            "access_code": case.access_code,
            "initial_brief": case.brief,
            "common_information": case.common_information,
            "simulation_duration": case.duration,
            "total_non_referred_personas": case.root_personas,
            "personas": personas,
        }
    }


async def updateCase(case_id: int, payload, admin: CurrentAdmin) -> dict:
    async with get_session() as session:
        case = await session.get(Case, case_id)
        if case is None:
            raise HTTPException(status_code=404, detail="Case not found.")
        caseAccess(case.admin, admin)
        normalized_code = normalizeAccessCode(payload.access_code)
        if normalized_code and await accessCodeTaken(session, normalized_code, exclude_case_id=case_id):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
        case.name = payload.case_name
        case.access_code = normalized_code
        case.brief = payload.initial_brief
        case.common_information = payload.common_information
        case.duration = payload.simulation_duration
        case.root_personas = payload.total_non_referred_personas
        # Always a full reassignment (never an in-place mutation of case.structure) so
        # SQLAlchemy's ORM change tracking picks it up — see infra/db_models.py.
        case.structure = await build_structure(session, payload)
        session.add(case)
        try:
            await session.commit()
        except Exception as exc:
            await session.rollback()
            if violation(exc):
                raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
            raise HTTPException(status_code=500, detail="Failed to update case.") from exc
    return {"case_id": case_id}


async def deleteCase(case_id: int, admin: CurrentAdmin) -> dict:
    async with get_session() as session:
        case = await session.get(Case, case_id)
        if case is None:
            raise HTTPException(status_code=404, detail="Case not found.")
        caseAccess(case.admin, admin)
        await session.delete(case)
        await session.commit()
    return {"ok": True}
