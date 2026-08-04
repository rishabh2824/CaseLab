from collections import Counter
from sqlalchemy import delete, or_
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from domain_errors import AccessCodeConflict, AccessDenied, CaseNotFound, InvalidRequest, PersistenceError, VersionConflict
from models.admin import AdminRole
from models.cases import (
    CaseCreatedResponse,
    CaseDeletedResponse,
    CaseDetail,
    CaseDetailResponse,
    CaseListResponse,
    CasePayload,
    CaseStructure,
    CaseSummary,
    CaseUpdatePayload,
    CaseVersionResponse,
    FileRef,
)
from services.auth import CurrentAdmin
from infra.db_models import Admin, Case, Collaborator, File


ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."
VERSION_CONFLICT = {
    "message": "This case was changed by someone else since you loaded it — reload to see their changes.",
    "code": "version_conflict",
}

# Hardcoded stand-in until a dedicated demo case exists
DEMO_CASE_ID = 1


# Authorize access to a case: SUPER admins bypass everything
async def caseAccess(session, case: Case, admin: CurrentAdmin) -> None:
    if admin.role == AdminRole.SUPER: return
    if case.admin == admin.id: return
    row = await session.exec(
        select(Collaborator.admin_id).where(Collaborator.case_id == case.id, Collaborator.admin_id == admin.id)
    )
    if row.first() is None:
        raise AccessDenied("You do not have access to this case.")


# Validates + normalizes a collaborator id list for create/update: dedupes, rejects the case owner appearing in their own
# collaborator list, rejects unknown admin ids, and rejects SUPER admins (they already have full access everywhere).
async def resolveCollaboratorIds(session, ids: list[int] | None, owner_admin_id: int) -> list[int]:
    ids = list(dict.fromkeys(ids or []))  # dedupe, preserve order
    if not ids: return []
    if owner_admin_id in ids:
        raise InvalidRequest("The case owner cannot also be listed as a collaborator.")
    rows = (await session.exec(select(Admin.id, Admin.role).where(Admin.id.in_(ids)))).all()
    found = {row[0]: row[1] for row in rows}
    missing = set(ids) - found.keys()
    if missing:
        raise InvalidRequest(f"Unknown admin id(s): {sorted(missing)}")
    if any(role == AdminRole.SUPER for role in found.values()):
        raise InvalidRequest("Super admins cannot be added as collaborators.")
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


# --- file dedup: get-or-create by object_key
async def resolveFileRef(session, file_ref: FileRef | None) -> dict | None:
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
        # Stringified even though the column is now a plain int id — this dict lands inside the JSONB structure/run blobs,
        # where file_id also serves as a dict key. JSON silently stringifies int dict keys on serialization, so keeping it
        # a string from the start avoids an int-vs-str mismatch after a round-trip.
        "file_id": str(file_row.id),
        "object_key": file_row.object_key,
        "file_name": file_row.name,
        "content_type": file_row.content_type,
    }


# Validates the flat persona/referral graph a save is about to write
def validateGraph(payload: CasePayload) -> None:
    persona_ids = [p.id for p in payload.personas]
    duplicates = sorted(pid for pid, count in Counter(persona_ids).items() if count > 1)
    if duplicates:
        raise InvalidRequest(f"Duplicate persona id(s): {duplicates}")
    valid_ids = set(persona_ids)

    for root_id in payload.roots:
        if root_id not in valid_ids:
            raise InvalidRequest(f"Unknown root persona id: {root_id}")
    for referral in payload.referrals:
        if referral.from_id not in valid_ids:
            raise InvalidRequest(f"Unknown referral from_id: {referral.from_id}")
        if referral.to_id not in valid_ids:
            raise InvalidRequest(f"Unknown referral to_id: {referral.to_id}")

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
                raise InvalidRequest(f"Referral cycle detected involving persona id: {cycle_node}")


async def buildStructure(session, payload: CasePayload) -> CaseStructure:
    validateGraph(payload)
    personas = []
    for persona in payload.personas:
        files = []
        for entry in persona.files:
            if not entry.file:
                continue
            files.append(
                {
                    "file": await resolveFileRef(session, entry.file),
                    "share_conditions": entry.share_conditions,
                    "perceived_contents": entry.perceived_contents,
                }
            )
        personas.append(
            {
                "id": persona.id,
                "name": persona.name,
                "role": persona.role,
                "profile_photo": await resolveFileRef(session, persona.profile_photo),
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


async def createCase(session, payload: CasePayload, admin: CurrentAdmin) -> CaseCreatedResponse:
    normalized_code = normalizeAccessCode(payload.access_code)
    if normalized_code and await accessCodeTaken(session, normalized_code):
        raise AccessCodeConflict(ACCESS_CODE_CONFLICT)
    collaborator_ids = await resolveCollaboratorIds(session, payload.collaborator_admin_ids, owner_admin_id=admin.id)
    case = Case(
        name=payload.case_name,
        access_code=normalized_code,
        brief=payload.brief,
        common_information=payload.common_information,
        duration=payload.simulation_duration,
        admin=admin.id,
        structure=(await buildStructure(session, payload)).model_dump(mode="json"),
    )
    session.add(case)
    try:
        await session.flush()  # assigns case.id without committing, needed for the collaborator rows below
    except Exception as exc:
        await session.rollback()
        if violation(exc):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to create case.") from exc
    session.add_all([Collaborator(case_id=case.id, admin_id=aid) for aid in collaborator_ids])
    try:
        await session.commit()
    except Exception as exc:
        await session.rollback()
        if violation(exc):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to create case.") from exc
    return CaseCreatedResponse(case_id=case.id)


async def listCases(session, admin: CurrentAdmin) -> CaseListResponse:
    cases = await fetchCases(session, admin)
    return CaseListResponse(
        cases=[CaseSummary(id=case.id, case_name=case.name, access_code=case.access_code) for case in cases]
    )


async def getCase(session, case_id: int, admin: CurrentAdmin) -> CaseDetailResponse:
    case = await session.get(Case, case_id)
    if case is None:
        raise CaseNotFound("Case not found.")
    await caseAccess(session, case, admin)
    collaborator_ids = (
        await session.exec(select(Collaborator.admin_id).where(Collaborator.case_id == case_id))
    ).all()
    structure = CaseStructure.model_validate(case.structure)
    return CaseDetailResponse(
        case=CaseDetail(
            id=case.id,
            case_name=case.name,
            access_code=case.access_code,
            brief=case.brief,
            common_information=case.common_information,
            simulation_duration=case.duration,
            personas=structure.personas,
            referrals=structure.referrals,
            roots=structure.roots,
            version=case.version,
            owner_admin_id=case.admin,
            collaborator_admin_ids=list(collaborator_ids),
        )
    )


async def getDemoCase(session) -> CaseDetailResponse:
    case = await session.get(Case, DEMO_CASE_ID)
    if case is None:
        raise CaseNotFound("Demo case is not configured.")
    structure = CaseStructure.model_validate(case.structure)
    return CaseDetailResponse(
        case=CaseDetail(
            case_name=case.name,
            access_code=case.access_code,
            brief=case.brief,
            common_information=case.common_information,
            simulation_duration=case.duration,
            personas=structure.personas,
            referrals=structure.referrals,
            roots=structure.roots,
        )
    )


async def getCaseVersion(session, case_id: int, admin: CurrentAdmin) -> CaseVersionResponse:
    case = await session.get(Case, case_id)
    if case is None:
        raise CaseNotFound("Case not found.")
    await caseAccess(session, case, admin)
    return CaseVersionResponse(version=case.version)


async def updateCase(session, case_id: int, payload: CaseUpdatePayload, admin: CurrentAdmin) -> CaseCreatedResponse:
    case = await session.get(Case, case_id)
    if case is None:
        raise CaseNotFound("Case not found.")
    await caseAccess(session, case, admin)

    normalized_code = normalizeAccessCode(payload.access_code)
    if normalized_code and await accessCodeTaken(session, normalized_code, exclude_case_id=case_id):
        raise AccessCodeConflict(ACCESS_CODE_CONFLICT)
    collaborator_ids = await resolveCollaboratorIds(session, payload.collaborator_admin_ids, owner_admin_id=case.admin)
    structure = (await buildStructure(session, payload)).model_dump(mode="json")

    try:
        result = await session.execute(
            sa_update(Case)
            .where(Case.id == case_id, Case.version == payload.expected_version)
            .values(
                name=payload.case_name,
                access_code=normalized_code,
                brief=payload.brief,
                common_information=payload.common_information,
                duration=payload.simulation_duration,
                structure=structure,
                version=Case.version + 1,
            )
        )
    except Exception as exc:
        await session.rollback()
        if violation(exc):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to update case.") from exc
    if result.rowcount == 0:
        await session.rollback()
        raise VersionConflict(VERSION_CONFLICT)

    # Replace-all, same convention as case.structure — not an incremental diff.
    await session.execute(delete(Collaborator).where(Collaborator.case_id == case_id))
    if collaborator_ids:
        session.add_all([Collaborator(case_id=case_id, admin_id=aid) for aid in collaborator_ids])

    try:
        await session.commit()
    except Exception as exc:
        await session.rollback()
        if violation(exc):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to update case.") from exc
    return CaseCreatedResponse(case_id=case_id)


async def deleteCase(session, case_id: int, admin: CurrentAdmin) -> CaseDeletedResponse:
    case = await session.get(Case, case_id)
    if case is None:
        raise CaseNotFound("Case not found.")
    await caseAccess(session, case, admin)
    await session.delete(case)
    await session.commit()
    return CaseDeletedResponse(ok=True)
