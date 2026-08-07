# CRUD for the ``admins`` table. Scale is ~20 admins total, so every function here does the simplest possible
# query rather than anything batched/paginated.

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import delete
from sqlalchemy import update as sa_update
from sqlmodel import select
from domain_errors import AdminEmailTaken, AdminNotFound, PersistenceError, SuperAdminProtected, Unauthorized
from infra.db_models import Admin, Case, Collaborator
from models.admin import DeleteAdmin, AdminOut, AdminRole
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
async def deleteWithCascade(session, admin_id: int) -> DeleteAdmin:
    existing = await getById(session, admin_id)
    if existing is None:
        raise AdminNotFound("Admin not found.")
    if existing.role == AdminRole.SUPER:
        raise SuperAdminProtected("Super admins cannot be deleted.")

    # Column projection, not select(Case): nothing here reads a case beyond its id (not
    # even the admin column being replaced -- the WHERE clause already proves that), so
    # there's no reason to pull every owned case's `structure` (the JSONB column that
    # dominates a case row) off disk just to decide whether to delete or reassign it.
    case_ids = (await session.exec(select(Case.id).where(Case.admin == admin_id))).all()

    # One query for every owned case's collaborators (ordered globally by added_at) instead
    # of one per case -- grouping the single result set by case_id in Python preserves each
    # group's oldest-first order, since it's a stable sub-order of the overall sort.
    collaborators_by_case: dict[int, list[Collaborator]] = {}
    if case_ids:
        all_collaborators = (
            await session.exec(
                select(Collaborator)
                .where(Collaborator.case_id.in_(case_ids))
                .order_by(Collaborator.added_at.asc())
            )
        ).all()
        for collaborator in all_collaborators:
            collaborators_by_case.setdefault(collaborator.case_id, []).append(collaborator)

    to_delete: list[int] = []
    reassignments: list[dict] = []
    collaborators_to_remove: list[Collaborator] = []
    for case_id in case_ids:
        collaborators = collaborators_by_case.get(case_id, [])
        if not collaborators:
            to_delete.append(case_id)
        else:
            oldest = collaborators[0]
            reassignments.append({"id": case_id, "admin": oldest.admin_id})  # promote
            collaborators_to_remove.append(oldest)  # they're the owner now, not a collaborator

    # Bulk delete/update by id instead of loading each Case as an ORM entity just to
    # call session.delete()/mutate .admin on it -- both operate directly off the ids
    # already in hand, still one statement each regardless of how many cases matched.
    if to_delete:
        await session.execute(delete(Case).where(Case.id.in_(to_delete)))
    if reassignments:
        await session.execute(sa_update(Case), reassignments)
    for collaborator in collaborators_to_remove:
        await session.delete(collaborator)

    cases_deleted = len(to_delete)
    cases_reassigned = len(reassignments)

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
    return DeleteAdmin(ok=True, cases_deleted=cases_deleted, cases_reassigned=cases_reassigned)
