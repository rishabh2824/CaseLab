from collections import Counter
from sqlalchemy import delete, or_
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException
from sqlmodel import select
from models.admin import AdminRole
from models.cases import CasePayload, CaseStructure, CaseUpdatePayload, FileRef
from services.auth import CurrentAdmin
from infra.db_models import Admin, Case, Collaborator, File


ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."
VERSION_CONFLICT = {
    "message": "This case was changed by someone else since you loaded it — reload to see their changes.",
    "code": "version_conflict",
}

# Hardcoded stand-in until a dedicated demo case exists (Sterling Industries,
# id 1, is just the most complete case on hand today) — swap this constant
# once that case is built. getDemoCase() below is the only thing that reads it.
DEMO_CASE_ID = 1


# Authorize access to a case: SUPER admins bypass everything, otherwise the
# caller must be the owner or a collaborator.
async def caseAccess(session, case: Case, admin: CurrentAdmin) -> None:
    if admin.role == AdminRole.SUPER: return
    if case.admin == admin.id: return
    row = await session.exec(
        select(Collaborator.admin_id).where(Collaborator.case_id == case.id, Collaborator.admin_id == admin.id)
    )
    if row.first() is None:
        raise HTTPException(status_code=403, detail="You do not have access to this case.")


# Validates + normalizes a collaborator id list for create/update: dedupes,
# rejects the case owner appearing in their own collaborator list, rejects
# unknown admin ids, and rejects SUPER admins (who already have full access
# everywhere, so explicitly granting it is meaningless).
async def resolveCollaboratorIds(session, ids: list[int] | None, owner_admin_id: int) -> list[int]:
    ids = list(dict.fromkeys(ids or []))  # dedupe, preserve order
    if not ids: return []
    if owner_admin_id in ids:
        raise HTTPException(status_code=400, detail="The case owner cannot also be listed as a collaborator.")
    rows = (await session.exec(select(Admin.id, Admin.role).where(Admin.id.in_(ids)))).all()
    found = {row[0]: row[1] for row in rows}
    missing = set(ids) - found.keys()
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown admin id(s): {sorted(missing)}")
    if any(role == AdminRole.SUPER for role in found.values()):
        raise HTTPException(status_code=400, detail="Super admins cannot be added as collaborators.")
    return ids


# Whether exc looks like a UNIQUE constraint violation from Postgres
def violation(exc: Exception) -> bool:
    if not isinstance(exc, IntegrityError): return False
    return getattr(exc.orig, "sqlstate", None) == "23505"


# whitespace case mismatches
def normalizeAccessCode(access_code: str | None) -> str | None:
    return access_code.strip() if access_code and access_code.strip() else None


async def accessCodeTaken(session, access_code: str, exclude_case_id: int | None = None) -> bool:
    stmt = select(Case.id).where(Case.access_code == access_code)
    if exclude_case_id:
        stmt = stmt.where(Case.id != exclude_case_id)
    result = await session.exec(stmt)
    return result.first() is not None


# --- file dedup: get-or-create by object_key, same as the old get_file_id ----
async def resolve_file_ref(session, file_ref: FileRef | None) -> dict | None:
    if file_ref is None:
        return None
    file_row = (
        await session.exec(select(File).where(File.object_key == file_ref.object_key))
    ).first()
    if file_row is None:
        file_row = File(
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
        "object_key": file_row.object_key,
        "file_name": file_row.name,
        "content_type": file_row.content_type,
    }


# Validates the flat persona/referral graph a save is about to write: duplicate
# ids, dangling from_id/to_id/roots references, and referral cycles are all things
# a nested tree ruled out by construction — flat JSONB storage doesn't, so this is
# the graph's referential-integrity check now that nothing else provides one.
def validateGraph(payload: CasePayload) -> None:
    persona_ids = [p.id for p in payload.personas]
    duplicates = sorted(pid for pid, count in Counter(persona_ids).items() if count > 1)
    if duplicates:
        raise HTTPException(status_code=400, detail=f"Duplicate persona id(s): {duplicates}")
    valid_ids = set(persona_ids)

    for root_id in payload.roots:
        if root_id not in valid_ids:
            raise HTTPException(status_code=400, detail=f"Unknown root persona id: {root_id}")
    for referral in payload.referrals:
        if referral.from_id not in valid_ids:
            raise HTTPException(status_code=400, detail=f"Unknown referral from_id: {referral.from_id}")
        if referral.to_id not in valid_ids:
            raise HTTPException(status_code=400, detail=f"Unknown referral to_id: {referral.to_id}")

    adjacency: dict[str, list[str]] = {}
    for referral in payload.referrals:
        adjacency.setdefault(referral.from_id, []).append(referral.to_id)

    UNVISITED, IN_PROGRESS, DONE = 0, 1, 2
    state = dict.fromkeys(persona_ids, UNVISITED)

    def visit(node: str) -> str | None:
        state[node] = IN_PROGRESS
        for neighbor in adjacency.get(node, []):
            if state[neighbor] == IN_PROGRESS: return neighbor
            if state[neighbor] == UNVISITED:
                cycle_node = visit(neighbor)
                if cycle_node is not None: return cycle_node
        state[node] = DONE
        return None

    for persona_id in persona_ids:
        if state[persona_id] == UNVISITED:
            cycle_node = visit(persona_id)
            if cycle_node is not None:
                raise HTTPException(status_code=400, detail=f"Referral cycle detected involving persona id: {cycle_node}")


async def build_structure(session, payload: CasePayload) -> CaseStructure:
    validateGraph(payload)
    personas = []
    for persona in payload.personas:
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
        personas.append(
            {
                # Trusted as given, never regenerated — the frontend is the sole id-issuing
                # authority (assigned once via crypto.randomUUID() when a persona is first
                # added), which is what makes ids stable across saves.
                "id": persona.id,
                "name": persona.name,
                "role": persona.role,
                "profile_photo": await resolve_file_ref(session, persona.profile_photo),
                "known_facts": persona.known_facts,
                "personality_traits": persona.personality_traits,
                "availability_minutes": persona.availability_minutes,
                "files": files,
            }
        )
    referrals = [
        {"from_id": referral.from_id, "to_id": referral.to_id, "conditions": referral.conditions}
        for referral in payload.referrals
    ]
    return CaseStructure(personas=personas, referrals=referrals, roots=list(payload.roots))


async def fetchCases(session, admin: CurrentAdmin) -> list[Case]:
    if admin.role == AdminRole.SUPER:
        stmt = select(Case).order_by(Case.name)
    else:
        collaborator_case_ids = select(Collaborator.case_id).where(Collaborator.admin_id == admin.id)
        stmt = (
            select(Case)
            .where(or_(Case.admin == admin.id, Case.id.in_(collaborator_case_ids)))
            .order_by(Case.name)
        )
    return (await session.exec(stmt)).all()


async def createCase(session, payload: CasePayload, admin: CurrentAdmin) -> dict:
    normalized_code = normalizeAccessCode(payload.access_code)
    if normalized_code and await accessCodeTaken(session, normalized_code):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    collaborator_ids = await resolveCollaboratorIds(session, payload.collaborator_admin_ids, owner_admin_id=admin.id)
    case = Case(
        name=payload.case_name,
        access_code=normalized_code,
        brief=payload.initial_brief,
        common_information=payload.common_information,
        duration=payload.simulation_duration,
        root_personas=len(payload.roots),
        admin=admin.id,
        structure=(await build_structure(session, payload)).model_dump(mode="json"),
    )
    session.add(case)
    await session.flush()  # assigns case.id without committing, needed for the collaborator rows below
    session.add_all([Collaborator(case_id=case.id, admin_id=aid) for aid in collaborator_ids])
    try:
        await session.commit()
    except Exception as exc:
        await session.rollback()
        if violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        raise HTTPException(status_code=500, detail="Failed to create case.") from exc
    return {"case_id": case.id}


async def listCases(session, admin: CurrentAdmin) -> dict:
    cases = await fetchCases(session, admin)
    return {
        "cases": [
            {"id": case.id, "case_name": case.name, "access_code": case.access_code} for case in cases
        ]
    }


async def getCase(session, case_id: int, admin: CurrentAdmin) -> dict:
    case = await session.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    await caseAccess(session, case, admin)
    collaborator_ids = (
        await session.exec(select(Collaborator.admin_id).where(Collaborator.case_id == case_id))
    ).all()
    structure = CaseStructure.model_validate(case.structure)
    return {
        "case": {
            "id": case.id,
            "case_name": case.name,
            "access_code": case.access_code,
            "initial_brief": case.brief,
            "common_information": case.common_information,
            "simulation_duration": case.duration,
            "personas": structure.personas,
            "referrals": structure.referrals,
            "roots": structure.roots,
            "version": case.version,
            "owner_admin_id": case.admin,
            "collaborator_admin_ids": list(collaborator_ids),
        }
    }



# Read-only and deliberately skips caseAccess: every signed-in admin — not
# just DEMO_CASE_ID's owner/collaborators — gets to see a fully filled-out
# example case. Safe to leave wide open because there's no matching write
# path; the response also drops version/owner/collaborator fields, which are
# meaningless for a case the viewer doesn't actually have access to.
async def getDemoCase(session) -> dict:
    case = await session.get(Case, DEMO_CASE_ID)
    if case is None:
        raise HTTPException(status_code=404, detail="Demo case is not configured.")
    structure = CaseStructure.model_validate(case.structure)
    return {
        "case": {
            "case_name": case.name,
            "access_code": case.access_code,
            "initial_brief": case.brief,
            "common_information": case.common_information,
            "simulation_duration": case.duration,
            "personas": structure.personas,
            "referrals": structure.referrals,
            "roots": structure.roots,
        }
    }


async def getCaseVersion(session, case_id: int, admin: CurrentAdmin) -> dict:
    case = await session.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    await caseAccess(session, case, admin)
    return {"version": case.version}


async def updateCase(session, case_id: int, payload: CaseUpdatePayload, admin: CurrentAdmin) -> dict:
    case = await session.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    await caseAccess(session, case, admin)

    # Validate everything before touching the row — an invalid payload should
    # never bump the version or partially write collaborators.
    normalized_code = normalizeAccessCode(payload.access_code)
    if normalized_code and await accessCodeTaken(session, normalized_code, exclude_case_id=case_id):
        raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT)
    collaborator_ids = await resolveCollaboratorIds(session, payload.collaborator_admin_ids, owner_admin_id=case.admin)
    structure = (await build_structure(session, payload)).model_dump(mode="json")

    # Optimistic lock: a plain ORM mutate-then-commit can't distinguish "row
    # updated" from "someone else already updated it", so this is a conditional
    # bulk UPDATE instead — 0 rows affected means payload.expected_version is
    # stale, i.e. another admin saved this case first.
    result = await session.execute(
        sa_update(Case)
        .where(Case.id == case_id, Case.version == payload.expected_version)
        .values(
            name=payload.case_name,
            access_code=normalized_code,
            brief=payload.initial_brief,
            common_information=payload.common_information,
            duration=payload.simulation_duration,
            root_personas=len(payload.roots),
            structure=structure,
            version=Case.version + 1,
        )
    )
    if result.rowcount == 0:
        await session.rollback()
        raise HTTPException(status_code=409, detail=VERSION_CONFLICT)

    # Replace-all, same convention as case.structure — not an incremental diff.
    await session.execute(delete(Collaborator).where(Collaborator.case_id == case_id))
    if collaborator_ids:
        session.add_all([Collaborator(case_id=case_id, admin_id=aid) for aid in collaborator_ids])

    try:
        await session.commit()
    except Exception as exc:
        await session.rollback()
        if violation(exc):
            raise HTTPException(status_code=409, detail=ACCESS_CODE_CONFLICT) from exc
        raise HTTPException(status_code=500, detail="Failed to update case.") from exc
    return {"case_id": case_id}


async def deleteCase(session, case_id: int, admin: CurrentAdmin) -> dict:
    case = await session.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    await caseAccess(session, case, admin)
    await session.delete(case)
    await session.commit()
    return {"ok": True}
