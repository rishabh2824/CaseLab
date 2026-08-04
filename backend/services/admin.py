# CRUD for the ``admins`` table. Scale is ~20 admins total, so every function here does the simplest possible
# query rather than anything batched/paginated.

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import delete
from sqlmodel import select
from domain_errors import AdminEmailTaken, AdminNotFound, PersistenceError, SuperAdminProtected, Unauthorized
from infra.db_models import Admin, Case, Collaborator
from models.admin import AdminDeletedResponse, AdminOut, AdminRole
from services.auth import verifyToken


async def loginWithGoogleCredential(session, credential: str) -> AdminOut:
    try:
        claims = await run_in_threadpool(verifyToken, credential)
    except ValueError as exc:
        raise Unauthorized(str(exc)) from exc

    admin = await getByEmail(session, claims["email"])
    if admin is None:
        raise Unauthorized("Your account is not authorized")
    return admin


async def getByEmail(session, email: str) -> AdminOut | None:
    admin = (await session.exec(select(Admin).where(Admin.email == email))).first()
    return AdminOut.model_validate(admin, from_attributes=True) if admin else None


async def getById(session, admin_id: int) -> AdminOut | None:
    admin = await session.get(Admin, admin_id)
    return AdminOut.model_validate(admin, from_attributes=True) if admin else None


async def listAll(session) -> list[AdminOut]:
    admins = (await session.exec(select(Admin).order_by(Admin.email))).all()
    return [AdminOut.model_validate(admin, from_attributes=True) for admin in admins]


async def create(session, email: str, name: str | None, role: int) -> AdminOut:
    if await getByEmail(session, email) is not None:
        raise AdminEmailTaken("An admin with this email already exists.")

    admin = Admin(email=email, name=name, role=role)
    session.add(admin)
    await session.commit()
    await session.refresh(admin)
    return AdminOut.model_validate(admin, from_attributes=True)


# Replaces the old blocking "can't delete an admin who owns cases" behavior.
# For every case this admin owns: delete it if nobody else has access, or
# promote the longest-standing collaborator to owner if someone does — a case
# only ever gets deleted once no admin has access to it anymore. Atomic: one
# commit at the end, so a failure partway through leaves nothing persisted.
async def deleteWithCascade(session, admin_id: int) -> AdminDeletedResponse:
    existing = await getById(session, admin_id)
    if existing is None:
        raise AdminNotFound("Admin not found.")
    if existing.role == AdminRole.SUPER:
        raise SuperAdminProtected("Super admins cannot be deleted.")

    owned_cases = (await session.exec(select(Case).where(Case.admin == admin_id))).all()
    cases_deleted = 0
    cases_reassigned = 0
    for case in owned_cases:
        collaborators = (
            await session.exec(
                select(Collaborator).where(Collaborator.case_id == case.id).order_by(Collaborator.added_at.asc())
            )
        ).all()
        if not collaborators:
            await session.delete(case)
            cases_deleted += 1
        else:
            oldest = collaborators[0]
            case.admin = oldest.admin_id  # promote
            session.add(case)
            await session.delete(oldest)  # they're the owner now, not a collaborator
            cases_reassigned += 1

    # Cascade-clean any rows where this admin is a *collaborator* elsewhere —
    # disjoint from the loop above by construction, since resolveCollaboratorIds
    # never lets an admin collaborate on their own case.
    await session.execute(delete(Collaborator).where(Collaborator.admin_id == admin_id))

    admin = await session.get(Admin, admin_id)
    if admin is not None:
        await session.delete(admin)

    try:
        await session.commit()
    except Exception as exc:
        await session.rollback()
        raise PersistenceError("Failed to delete admin.") from exc
    return AdminDeletedResponse(ok=True, cases_deleted=cases_deleted, cases_reassigned=cases_reassigned)
