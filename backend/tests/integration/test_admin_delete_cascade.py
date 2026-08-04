import pytest
from sqlmodel import select
from api.admin import deleteAdmin as deleteAdminRoute
from domain_errors import PersistenceError, SuperAdminProtected
from infra.db_models import Admin, Case, Collaborator
from models.admin import AdminRole
from services import admin as admin_service
from services import cases as case_service
from tests.factories import asCurrentAdmin, createPayload


async def test_zero_collaborator_case_is_deleted(session, cleanup):
    owner = await cleanup.make_admin()
    created = await case_service.createCase(session, createPayload(), asCurrentAdmin(owner))
    case_id = created.case_id
    cleanup.track_case(case_id)  # no-op at teardown if already gone

    result = await admin_service.deleteWithCascade(session, owner.id)
    assert result.cases_deleted == 1
    assert result.cases_reassigned == 0

    assert await session.get(Case, case_id) is None
    assert await session.get(Admin, owner.id) is None


async def test_case_with_collaborators_is_reassigned_to_the_oldest(session, cleanup):
    owner = await cleanup.make_admin()
    older_collaborator = await cleanup.make_admin()
    newer_collaborator = await cleanup.make_admin()

    created = await case_service.createCase(
        session,
        createPayload(collaborator_admin_ids=[older_collaborator.id, newer_collaborator.id]),
        asCurrentAdmin(owner),
    )
    case_id = created.case_id
    cleanup.track_case(case_id)

    # createCase inserts both collaborator rows at ~the same instant — force a
    # deterministic ordering so "oldest collaborator" has an unambiguous answer.
    older_row = (
        await session.exec(
            select(Collaborator).where(
                Collaborator.case_id == case_id, Collaborator.admin_id == older_collaborator.id
            )
        )
    ).one()
    older_row.added_at -= 100
    session.add(older_row)
    await session.commit()

    result = await admin_service.deleteWithCascade(session, owner.id)
    assert result.cases_deleted == 0
    assert result.cases_reassigned == 1

    refreshed_case = await session.get(Case, case_id)
    assert refreshed_case is not None
    assert refreshed_case.admin == older_collaborator.id

    # The promoted admin is no longer listed as a collaborator on their own case.
    remaining = (await session.exec(select(Collaborator.admin_id).where(Collaborator.case_id == case_id))).all()
    assert remaining == [newer_collaborator.id]

    assert await session.get(Admin, owner.id) is None


async def test_deleting_a_collaborator_elsewhere_only_removes_that_grant(session, cleanup):
    owner = await cleanup.make_admin()
    collaborator = await cleanup.make_admin()

    created = await case_service.createCase(
        session, createPayload(collaborator_admin_ids=[collaborator.id]), asCurrentAdmin(owner)
    )
    case_id = created.case_id
    cleanup.track_case(case_id)

    result = await admin_service.deleteWithCascade(session, collaborator.id)
    assert result.cases_deleted == 0
    assert result.cases_reassigned == 0

    refreshed_case = await session.get(Case, case_id)
    assert refreshed_case is not None
    assert refreshed_case.admin == owner.id

    remaining = (await session.exec(select(Collaborator.admin_id).where(Collaborator.case_id == case_id))).all()
    assert remaining == []

    assert await session.get(Admin, collaborator.id) is None


async def test_delete_with_cascade_is_atomic_on_failure(session, cleanup, monkeypatch):
    owner = await cleanup.make_admin()
    owner_id = owner.id  # captured before deleteWithCascade — see note below
    created = await case_service.createCase(session, createPayload(), asCurrentAdmin(owner))
    case_id = created.case_id
    cleanup.track_case(case_id)

    async def failingCommit():
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(session, "commit", failingCommit)

    with pytest.raises(PersistenceError):
        await admin_service.deleteWithCascade(session, owner_id)

    # session.rollback() inside deleteWithCascade's except block expires every
    # persistent object in this session's identity map — not just the case,
    # but `owner` too (deleteWithCascade called session.delete(admin) on it
    # before the rollback). Touching an expired attribute on either object
    # outside an awaited refresh trips SQLAlchemy's async MissingGreenlet
    # guard, so this only reads via session.get()/refresh(), never `owner.id`.
    survived_case = await session.get(Case, case_id)
    assert survived_case is not None
    await session.refresh(survived_case)
    assert survived_case.admin == owner_id
    assert await session.get(Admin, owner_id) is not None


async def test_deleting_a_super_admin_still_403s(session, cleanup):
    super_admin = await cleanup.make_admin(role=AdminRole.SUPER)
    with pytest.raises(SuperAdminProtected) as exc_info:
        await deleteAdminRoute(super_admin.id, session)
    assert exc_info.value.status_code == 403
