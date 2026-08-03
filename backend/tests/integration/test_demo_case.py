import pytest
from domain_errors import CaseNotFound
from services import cases as case_service

from tests import factories

# getDemoCase is the one case read that deliberately skips the access check, so
# what it does and does not expose is worth pinning.
#
# These tests used to read whatever case happened to be sitting at
# DEMO_CASE_ID in the live database, which meant they asserted against
# production data: they could not pass against a fresh database at all (so CI
# was impossible), and editing that one row could turn them red with no code
# change. Each test now creates the case it points DEMO_CASE_ID at.


async def test_get_demo_case_returns_the_configured_case(session, cleanup, monkeypatch):
    owner = factories.asCurrentAdmin(await cleanup.make_admin())
    created = await case_service.createCase(
        session,
        factories.createPayload(
            case_name="Demo Case",
            initial_brief="A worked example.",
            common_information="Shared background.",
            personas=[factories.persona("A", name="Mary")],
            roots=["A"],
        ),
        owner,
    )
    cleanup.track_case(created["case_id"])
    monkeypatch.setattr(case_service, "DEMO_CASE_ID", created["case_id"])

    case = (await case_service.getDemoCase(session))["case"]
    assert case["case_name"] == "Demo Case"
    assert case["initial_brief"] == "A worked example."
    assert [persona["name"] for persona in case["personas"]] == ["Mary"]


async def test_get_demo_case_omits_owner_version_and_collaborator_fields(session, cleanup, monkeypatch):
    # The viewer is any signed-in admin, not necessarily someone with access to
    # this case — so the fields that only mean something to a real
    # owner/collaborator must not be in the response at all.
    owner = factories.asCurrentAdmin(await cleanup.make_admin())
    created = await case_service.createCase(session, factories.createPayload(case_name="Demo Case"), owner)
    cleanup.track_case(created["case_id"])
    monkeypatch.setattr(case_service, "DEMO_CASE_ID", created["case_id"])

    case = (await case_service.getDemoCase(session))["case"]
    for field in ("id", "version", "owner_admin_id", "collaborator_admin_ids"):
        assert field not in case, f"{field} must not be exposed by the demo endpoint"


async def test_get_demo_case_404s_when_not_configured(session, monkeypatch):
    monkeypatch.setattr(case_service, "DEMO_CASE_ID", 999_999_999)
    with pytest.raises(CaseNotFound):
        await case_service.getDemoCase(session)
