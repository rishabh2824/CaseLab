import pytest
from domain_errors import AccessDenied, InvalidRequest
from models.admin import AdminRole
from services import cases as case_service
from tests.factories import asCurrentAdmin, createPayload, updatePayload


async def test_owner_can_read_update_and_delete_own_case(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())

    created = await case_service.createCase(session, createPayload(), owner)
    case_id = created.case_id
    cleanup.track_case(case_id)

    detail = await case_service.getCase(session, case_id, owner)
    assert detail.case.owner_admin_id == owner.id
    assert detail.case.version == 1

    updated = await case_service.updateCase(session, case_id, updatePayload(1, case_name="Renamed"), owner)
    assert updated.case_id == case_id

    result = await case_service.deleteCase(session, case_id, owner)
    assert result.ok is True


async def test_non_owner_non_collaborator_gets_403_on_every_action(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    stranger = asCurrentAdmin(await cleanup.make_admin())

    created = await case_service.createCase(session, createPayload(), owner)
    case_id = created.case_id
    cleanup.track_case(case_id)

    with pytest.raises(AccessDenied):
        await case_service.getCase(session, case_id, stranger)

    with pytest.raises(AccessDenied):
        await case_service.updateCase(session, case_id, updatePayload(1), stranger)

    with pytest.raises(AccessDenied):
        await case_service.deleteCase(session, case_id, stranger)


async def test_collaborator_has_full_access_including_managing_collaborators(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    collaborator_admin = await cleanup.make_admin()
    collaborator = asCurrentAdmin(collaborator_admin)
    third_admin = await cleanup.make_admin()

    created = await case_service.createCase(
        session, createPayload(collaborator_admin_ids=[collaborator_admin.id]), owner
    )
    case_id = created.case_id
    cleanup.track_case(case_id)

    detail = await case_service.getCase(session, case_id, collaborator)
    assert detail.case.collaborator_admin_ids == [collaborator_admin.id]

    # Collaborator has full edit access: they can update the case and change
    # the collaborator list itself, dropping themselves and adding a third admin.
    await case_service.updateCase(
        session, case_id, updatePayload(1, collaborator_admin_ids=[third_admin.id]), collaborator
    )

    with pytest.raises(AccessDenied):
        await case_service.getCase(session, case_id, collaborator)

    third = asCurrentAdmin(third_admin)
    detail2 = await case_service.getCase(session, case_id, third)
    assert detail2.case.collaborator_admin_ids == [third_admin.id]

    # Full access also means a collaborator can delete the case — no owner/collaborator distinction.
    result = await case_service.deleteCase(session, case_id, third)
    assert result.ok is True


async def test_super_admin_bypasses_access_check(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    super_admin = asCurrentAdmin(await cleanup.make_admin(role=AdminRole.SUPER))

    created = await case_service.createCase(session, createPayload(), owner)
    case_id = created.case_id
    cleanup.track_case(case_id)

    detail = await case_service.getCase(session, case_id, super_admin)
    assert detail.case.owner_admin_id == owner.id

    updated = await case_service.updateCase(session, case_id, updatePayload(1), super_admin)
    assert updated.case_id == case_id


async def test_list_cases_returns_owned_and_collaborator_union_for_regular_admin(session, cleanup):
    admin_a_row = await cleanup.make_admin()
    admin_a = asCurrentAdmin(admin_a_row)
    admin_b_row = await cleanup.make_admin()
    admin_b = asCurrentAdmin(admin_b_row)

    owned = await case_service.createCase(session, createPayload(case_name="Owned by A"), admin_a)
    cleanup.track_case(owned.case_id)
    shared = await case_service.createCase(
        session, createPayload(case_name="Shared with B", collaborator_admin_ids=[admin_b_row.id]), admin_a
    )
    cleanup.track_case(shared.case_id)
    unrelated = await case_service.createCase(session, createPayload(case_name="Unrelated"), admin_a)
    cleanup.track_case(unrelated.case_id)

    listing = await case_service.listCases(session, admin_b)
    ids = {c.id for c in listing.cases}
    assert shared.case_id in ids
    assert owned.case_id not in ids
    assert unrelated.case_id not in ids


async def test_list_cases_returns_everything_for_super_admin(session, cleanup):
    admin_a = asCurrentAdmin(await cleanup.make_admin())
    super_admin = asCurrentAdmin(await cleanup.make_admin(role=AdminRole.SUPER))

    created = await case_service.createCase(session, createPayload(case_name="Owned by A, unrelated to SUPER"), admin_a)
    cleanup.track_case(created.case_id)

    listing = await case_service.listCases(session, super_admin)
    ids = {c.id for c in listing.cases}
    assert created.case_id in ids


async def test_resolve_collaborator_ids_rejects_owner_as_collaborator(session, cleanup):
    owner = await cleanup.make_admin()
    with pytest.raises(InvalidRequest):
        await case_service.resolveCollaboratorIds(session, [owner.id], owner_admin_id=owner.id)


async def test_resolve_collaborator_ids_rejects_unknown_admin_id(session, cleanup):
    owner = await cleanup.make_admin()
    with pytest.raises(InvalidRequest):
        await case_service.resolveCollaboratorIds(session, [999_999_999], owner_admin_id=owner.id)


async def test_resolve_collaborator_ids_rejects_super_admin(session, cleanup):
    owner = await cleanup.make_admin()
    super_admin = await cleanup.make_admin(role=AdminRole.SUPER)
    with pytest.raises(InvalidRequest):
        await case_service.resolveCollaboratorIds(session, [super_admin.id], owner_admin_id=owner.id)
