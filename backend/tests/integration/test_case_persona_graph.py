import pytest
from domain_errors import InvalidRequest
from services import cases as case_service
from tests.factories import asCurrentAdmin, createPayload, persona, referral, updatePayload


# The tree-shaped storage this replaced could never express two personas
# referring to the same third persona — this is the concrete case the
# refactor set out to unlock.
async def test_multi_parent_referral_saves_and_round_trips(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    payload = createPayload(
        personas=[persona("A", name="Mary"), persona("B", name="John"), persona("C", name="Shared CFO")],
        referrals=[referral("A", "C"), referral("B", "C")],
        roots=["A", "B"],
    )
    created = await case_service.createCase(session, payload, owner)
    case_id = created.case_id
    cleanup.track_case(case_id)

    detail = await case_service.getCase(session, case_id, owner)
    stored_referrals = {(r.from_id, r.to_id) for r in detail.case.referrals}
    assert stored_referrals == {("A", "C"), ("B", "C")}
    assert set(detail.case.roots) == {"A", "B"}


async def test_cyclic_referral_graph_is_rejected(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    payload = createPayload(
        personas=[persona("A"), persona("B")],
        referrals=[referral("A", "B"), referral("B", "A")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        await case_service.createCase(session, payload, owner)


async def test_dangling_referral_reference_is_rejected(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    payload = createPayload(
        personas=[persona("A")],
        referrals=[referral("A", "does-not-exist")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        await case_service.createCase(session, payload, owner)


async def test_dangling_root_reference_is_rejected(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    payload = createPayload(personas=[persona("A")], referrals=[], roots=["A", "does-not-exist"])
    with pytest.raises(InvalidRequest):
        await case_service.createCase(session, payload, owner)


async def test_duplicate_persona_ids_are_rejected(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    payload = createPayload(
        personas=[persona("A", name="First"), persona("A", name="Second")],
        referrals=[],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        await case_service.createCase(session, payload, owner)


# The concrete proof the "regenerate a fresh uuid on every save" bug is gone —
# the same client-supplied id must survive an update untouched.
async def test_persona_ids_are_stable_across_create_then_update(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    created = await case_service.createCase(
        session, createPayload(personas=[persona("A")], referrals=[], roots=["A"]), owner
    )
    case_id = created.case_id
    cleanup.track_case(case_id)

    detail = await case_service.getCase(session, case_id, owner)
    assert [p.id for p in detail.case.personas] == ["A"]

    await case_service.updateCase(
        session,
        case_id,
        updatePayload(1, personas=[persona("A", name="Renamed")], referrals=[], roots=["A"]),
        owner,
    )

    detail2 = await case_service.getCase(session, case_id, owner)
    assert [p.id for p in detail2.case.personas] == ["A"]
    assert detail2.case.personas[0].name == "Renamed"
