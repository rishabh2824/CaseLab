from collections import Counter
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import String, cast, delete, or_
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from domain_errors import AccessCodeConflict, AccessDenied, CaseNotFound, DomainError, InvalidRequest, PersistenceError, VersionConflict
from models.admin import AdminRole
from models.cases import (
    CaseCreated,
    CaseDeleted,
    CaseDetail,
    CaseDetailResponse,
    CaseList,
    CasePayload,
    CaseStructure,
    CaseSummary,
    CaseUpdate,
    CaseVersion,
    FileRef,
    PersonaPayload,
)
from services.auth import CurrentAdmin
from infra.db_models import Admin, Case, Collaborator, File
from infra.spaces import deleteObject


ACCESS_CODE_CONFLICT = "An access code with this value already exists on another case."
# Matches the partial unique index declared in Case.__table_args__ (infra/db_models.py).
ACCESS_CODE_UNIQUE_CONSTRAINT = "idx_cases_access_code_unique"
VERSION_CONFLICT = {
    "message": "This case was changed by someone else since you loaded it — reload to see their changes.",
    "code": "version_conflict",
}

# Hardcoded stand-in until a dedicated demo case exists
DEMO_CASE_ID = 1


# Authorize access to a case: SUPER admins bypass everything. Takes the case's id/owner
# as plain values rather than a `Case` ORM instance so callers that only ever needed
# those two columns (getCaseVersion) aren't forced to fetch the whole row -- including
# `structure`, the JSONB column that dominates it -- just to check access.
async def caseAccess(session, case_id: int, owner_admin_id: int, admin: CurrentAdmin) -> None:
    if admin.role == AdminRole.SUPER: return
    if owner_admin_id == admin.id: return
    row = await session.exec(
        select(Collaborator.admin_id).where(Collaborator.case_id == case_id, Collaborator.admin_id == admin.id)
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


# Whether exc is a UNIQUE constraint violation of the specific named constraint — not just
# any unique violation. Two different constraints can raise here (idx_cases_access_code_unique
# and uq_files_object_key, the latter from resolveFileRefs's get-or-create racing a concurrent
# request creating the same brand-new file), and they mean different things to the caller —
# checking only the generic 23505 sqlstate can't tell them apart.
def violation(exc: Exception, constraint_name: str) -> bool:
    if not isinstance(exc, IntegrityError): return False
    # exc.orig is SQLAlchemy's async postgres dialect's DBAPI-compatibility shim
    # (AsyncAdapt_asyncpg_dbapi.IntegrityError), which doesn't forward asyncpg's own
    # diagnostic fields -- the real asyncpg.exceptions.UniqueViolationError (the thing
    # that actually carries .constraint_name) is one level down, as its __cause__.
    orig = exc.orig
    name = getattr(orig, "constraint_name", None) or getattr(orig.__cause__, "constraint_name", None)
    return name == constraint_name


# whitespace case mismatches
def normalizeAccessCode(access_code: str | None) -> str | None:
    return access_code.strip() if access_code and access_code.strip() else None


async def accessCodeTaken(session, access_code: str, exclude_case_id: int | None = None) -> bool:
    # access_code is already guaranteed non-empty by the caller (normalizeAccessCode), so
    # `!= ""` never actually excludes a row here -- it's there so the WHERE clause literally
    # matches idx_cases_access_code_unique's partial predicate (access_code IS NOT NULL AND
    # access_code != ''). Without it, a generic/prepared plan (unlike asyncpg's typical
    # Bind-time custom plan) can't prove `access_code = $1` implies the index's predicate,
    # since it can't see that $1 is never ''  and would fall back to a seq scan.
    stmt = select(Case.id).where(
        Case.access_code == access_code,
        Case.access_code.is_not(None),
        Case.access_code != "",
    )
    if exclude_case_id:
        stmt = stmt.where(Case.id != exclude_case_id)
    result = await session.exec(stmt)
    return result.first() is not None


def _shapeFileRow(file_row: File) -> dict:
    return {
        # Stringified even though the column is now a plain int id — this dict lands inside the JSONB structure/run blobs,
        # where file_id also serves as a dict key. JSON silently stringifies int dict keys on serialization, so keeping it
        # a string from the start avoids an int-vs-str mismatch after a round-trip.
        "file_id": str(file_row.id),
        "object_key": file_row.object_key,
        "file_name": file_row.name,
        "content_type": file_row.content_type,
    }


# --- file dedup: get-or-create by object_key
async def resolveFileRef(session, file_ref: FileRef | None) -> dict | None:
    return (await resolveFileRefs(session, [file_ref]))[0]


# Batched get-or-create by object_key: one SELECT ... WHERE object_key IN (...) covering
# every distinct key across the whole list, plus at most one bulk INSERT for whatever's
# missing (deduped so two refs new to the DB but sharing an object_key — e.g. two personas
# given the same brand-new photo in one save — insert a single row, not two racing to
# violate uq_files_object_key), instead of a SELECT + possible INSERT per file. buildStructure
# calls this once per case save instead of resolveFileRef once per persona photo/attachment.
async def resolveFileRefs(session, file_refs: list[FileRef | None]) -> list[dict | None]:
    object_keys = {ref.object_key for ref in file_refs if ref is not None}
    if not object_keys:
        return [None for _ in file_refs]

    existing = (await session.exec(select(File).where(File.object_key.in_(object_keys)))).all()
    by_key = {file_row.object_key: file_row for file_row in existing}

    new_rows = {
        ref.object_key: File(object_key=ref.object_key, name=ref.file_name, content_type=ref.content_type)
        for ref in file_refs
        if ref is not None and ref.object_key not in by_key
    }
    if new_rows:
        session.add_all(new_rows.values())
        await session.flush()  # assigns ids without committing the outer transaction
        by_key.update(new_rows)

    return [_shapeFileRow(by_key[ref.object_key]) if ref is not None else None for ref in file_refs]


# Every file_id (profile photo + persona attachments) referenced by a persona list — the
# same PersonaPayload shape backs both CaseStructure.personas (what's stored) and
# CasePayload.personas (what's being saved), so this walks either one.
def extractFileIds(personas: list[PersonaPayload]) -> set[str]:
    file_ids: set[str] = set()
    for persona in personas:
        if persona.profile_photo and persona.profile_photo.file_id:
            file_ids.add(persona.profile_photo.file_id)
        for entry in persona.files:
            if entry.file and entry.file.file_id:
                file_ids.add(entry.file.file_id)
    return file_ids


# Which of `file_ids` still appear in *any* case's structure, in one pass. A file can
# legitimately be shared across cases (resolveFileRefs dedupes by object_key, e.g. creating
# from a template without replacing the photo reuses the same File row) — so before deleting
# one, every case has to be checked, not just the one being saved/deleted. structure is
# arbitrary nested JSONB (a photo under personas[].profile_photo, an attachment under
# personas[].files[].file), so this is a text search over the JSONB's canonical serialization
# rather than a JSONB path query per nesting shape — file_id is always a stringified int (see
# resolveFileRefs), so it can't contain characters that would make the needle ambiguous. The
# needle has a space after the colon (`"file_id": "7"`, not `"file_id":"7"`) because that's
# what Postgres's own `jsonb::text` cast produces, not Python's compact json.dumps.
#
# One query for the whole batch, not one full-table scan per file_id: fetch (as text) only
# the structures that match at least one needle, then check each needle against that already-
# narrowed set in Python.
async def referencedFileIds(session, file_ids: set[str]) -> set[str]:
    if not file_ids:
        return set()
    needles = {file_id: f'"file_id": "{file_id}"' for file_id in file_ids}
    text_col = cast(Case.structure, String)
    result = await session.exec(
        select(text_col).where(or_(*(text_col.like(f"%{needle}%") for needle in needles.values())))
    )
    structures = result.all()
    return {
        file_id
        for file_id, needle in needles.items()
        if any(needle in structure for structure in structures)
    }


# Deletes every file_id in `file_ids` that's no longer referenced by any case — the Spaces
# object first, then the `files` row. Call only after the case mutation that might have
# orphaned them has already committed (deleting the case, or overwriting its structure on
# update), so referencedFileIds sees the post-mutation state. Best-effort and isolated per
# file: a Spaces or DB hiccup here must not turn an already-successful case save/delete into
# a failure for the admin — this is storage hygiene, not the primary operation. Catches only
# new leaks going forward; a file orphaned before this existed is untouched by it.
async def deleteOrphanedFiles(session, file_ids: set[str]) -> None:
    try:
        still_referenced = await referencedFileIds(session, file_ids)
    except Exception:
        await session.rollback()
        # Can't confirm which are safe — leave every candidate alone rather than risk
        # deleting one that's actually still referenced.
        return
    for file_id in file_ids - still_referenced:
        db_id = int(file_id)
        try:
            # Column projection, not session.get(File, ...): a plain scalar isn't an
            # ORM-tracked entity, so the commit right below doesn't leave anything
            # expired that a later access would silently re-SELECT for. session.exec()
            # on a single-column select() returns that column's bare values, not Row
            # tuples -- this is already the object_key string itself, not a row to
            # project a .object_key attribute off of.
            object_key = (await session.exec(select(File.object_key).where(File.id == db_id))).first()
            # Commit the read here, before deleteObject: referencedFileIds' SELECT
            # above already opened a transaction (SQLAlchemy autobegin), and
            # deleteObject is a real network call -- leaving a pooled Postgres
            # connection idle-in-transaction for its duration, once per orphaned
            # file, was the actual bug. Committing now closes that out before the
            # network call, not after.
            await session.commit()
            if object_key is None:
                continue
            # A real HTTPS DELETE has no business blocking the event loop -- same
            # run_in_threadpool pattern admin.py already uses for its one blocking call.
            await run_in_threadpool(deleteObject, object_key)
            await session.execute(delete(File).where(File.id == db_id))
            await session.commit()
        except Exception:
            await session.rollback()


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

    # Collect every FileRef in the payload (each persona's profile_photo, then each of
    # their file entries) in a fixed order, resolve them all in one resolveFileRefs call,
    # then consume the results back in that same order below — one round trip for the
    # whole case save instead of one per photo/attachment.
    file_refs = []
    for persona in payload.personas:
        file_refs.append(persona.profile_photo)
        file_refs.extend(entry.file for entry in persona.files)
    resolved = iter(await resolveFileRefs(session, file_refs))

    personas = []
    for persona in payload.personas:
        profile_photo = next(resolved)
        files = []
        for entry in persona.files:
            resolved_file = next(resolved)
            if not entry.file:
                continue
            files.append(
                {
                    "file": resolved_file,
                    "share_conditions": entry.share_conditions,
                    "perceived_contents": entry.perceived_contents,
                }
            )
        personas.append(
            {
                "id": persona.id,
                "name": persona.name,
                "role": persona.role,
                "profile_photo": profile_photo,
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


# Column projection, not `select(Case)`: listCases (the admin dashboard's most-loaded
# page) only ever reads id/name/access_code, never `structure` -- the JSONB column that
# dominates a case row's size. Rows come back as (id, name, access_code) tuples.
async def fetchCases(session, admin: CurrentAdmin):
    columns = (Case.id, Case.name, Case.access_code)
    if admin.role == AdminRole.SUPER:
        stmt = select(*columns).order_by(Case.name)
    else:
        collaborator_case_ids = select(Collaborator.case_id).where(Collaborator.admin_id == admin.id)
        stmt = (
            select(*columns)
            .where(or_(Case.admin == admin.id, Case.id.in_(collaborator_case_ids)))
            .order_by(Case.name)
        )
    return (await session.exec(stmt)).all()


async def createCase(session, payload: CasePayload, admin: CurrentAdmin) -> CaseCreated:
    normalized_code = normalizeAccessCode(payload.access_code)
    if normalized_code and await accessCodeTaken(session, normalized_code):
        raise AccessCodeConflict(ACCESS_CODE_CONFLICT)
    collaborator_ids = await resolveCollaboratorIds(session, payload.collaborator_admin_ids, owner_admin_id=admin.id)
    try:
        # buildStructure (via resolveFileRefs) can itself flush an INSERT that races a
        # concurrent request creating the same brand-new file (uq_files_object_key) — it
        # has to run inside this try, not as a Case(...) constructor argument evaluated
        # before the try even starts, or that IntegrityError would propagate raw as a 500
        # instead of being mapped below.
        structure = (await buildStructure(session, payload)).model_dump(mode="json")
        case = Case(
            name=payload.case_name,
            access_code=normalized_code,
            brief=payload.brief,
            common_information=payload.common_information,
            duration=payload.simulation_duration,
            admin=admin.id,
            structure=structure,
        )
        session.add(case)
        await session.flush()  # assigns case.id without committing, needed for the collaborator rows below
    except DomainError:
        # buildStructure's validateGraph() raises InvalidRequest for bad input (duplicate
        # persona ids, dangling/cyclic referrals) before any DB I/O -- a business-rule
        # rejection, not a persistence failure, so it must reach the caller as itself
        # rather than get wrapped into a PersistenceError 500 below.
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        if violation(exc, ACCESS_CODE_UNIQUE_CONSTRAINT):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to create case.") from exc
    session.add_all([Collaborator(case_id=case.id, admin_id=aid) for aid in collaborator_ids])
    try:
        await session.commit()
    except Exception as exc:
        await session.rollback()
        if violation(exc, ACCESS_CODE_UNIQUE_CONSTRAINT):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to create case.") from exc
    return CaseCreated(case_id=case.id)


async def listCases(session, admin: CurrentAdmin) -> CaseList:
    rows = await fetchCases(session, admin)
    return CaseList(
        cases=[CaseSummary(id=id_, case_name=name, access_code=access_code) for id_, name, access_code in rows]
    )


async def getCase(session, case_id: int, admin: CurrentAdmin) -> CaseDetailResponse:
    case = await session.get(Case, case_id)
    if case is None:
        raise CaseNotFound("Case not found.")
    await caseAccess(session, case.id, case.admin, admin)
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


# Column projection, not session.get(Case, ...): this is useCaseVersionPoll.svelte.ts's
# 12-second poll, specifically designed to be a cheap check -- fetching the whole row
# (dominated by the `structure` JSONB column) on every poll defeated that.
async def getCaseVersion(session, case_id: int, admin: CurrentAdmin) -> CaseVersion:
    row = (await session.exec(select(Case.admin, Case.version).where(Case.id == case_id))).first()
    if row is None:
        raise CaseNotFound("Case not found.")
    owner_admin_id, version = row
    await caseAccess(session, case_id, owner_admin_id, admin)
    return CaseVersion(version=version)


async def updateCase(session, case_id: int, payload: CaseUpdate, admin: CurrentAdmin) -> CaseCreated:
    case = await session.get(Case, case_id)
    if case is None:
        raise CaseNotFound("Case not found.")
    await caseAccess(session, case.id, case.admin, admin)

    normalized_code = normalizeAccessCode(payload.access_code)
    if normalized_code and await accessCodeTaken(session, normalized_code, exclude_case_id=case_id):
        raise AccessCodeConflict(ACCESS_CODE_CONFLICT)
    collaborator_ids = await resolveCollaboratorIds(session, payload.collaborator_admin_ids, owner_admin_id=case.admin)
    old_file_ids = extractFileIds(CaseStructure.model_validate(case.structure).personas)
    try:
        # buildStructure (via resolveFileRefs) can itself flush an INSERT that races a
        # concurrent request creating the same brand-new file (uq_files_object_key) —
        # map that here rather than letting it propagate raw as a 500.
        new_structure = await buildStructure(session, payload)
    except DomainError:
        # Same as createCase above: validateGraph()'s InvalidRequest is a business-rule
        # rejection, not a persistence failure -- it must not be re-wrapped below.
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        if violation(exc, ACCESS_CODE_UNIQUE_CONSTRAINT):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to update case.") from exc
    dropped_file_ids = old_file_ids - extractFileIds(new_structure.personas)
    structure = new_structure.model_dump(mode="json")

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
        if violation(exc, ACCESS_CODE_UNIQUE_CONSTRAINT):
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
        if violation(exc, ACCESS_CODE_UNIQUE_CONSTRAINT):
            raise AccessCodeConflict(ACCESS_CODE_CONFLICT) from exc
        raise PersistenceError("Failed to update case.") from exc
    if dropped_file_ids:
        await deleteOrphanedFiles(session, dropped_file_ids)
    return CaseCreated(case_id=case_id)


async def deleteCase(session, case_id: int, admin: CurrentAdmin) -> CaseDeleted:
    case = await session.get(Case, case_id)
    if case is None:
        raise CaseNotFound("Case not found.")
    await caseAccess(session, case.id, case.admin, admin)
    file_ids = extractFileIds(CaseStructure.model_validate(case.structure).personas)
    await session.delete(case)
    await session.commit()
    if file_ids:
        await deleteOrphanedFiles(session, file_ids)
    return CaseDeleted(ok=True)
