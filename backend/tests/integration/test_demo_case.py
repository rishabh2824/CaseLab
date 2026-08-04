import pytest
from domain_errors import CaseNotFound
from services import cases as case_service

from tests import factories

# getDemoCase is the one case read that deliberately skips the access check, so
# what it does and does not expose is worth pinning. Each test creates the
# case it points DEMO_CASE_ID at, so it runs against a fresh database.


async def test_get_demo_case_returns_the_configured_case(session, cleanup, monkeypatch):
    owner = factories.asCurrentAdmin(await cleanup.make_admin())
    created = await case_service.createCase(
        session,
        factories.createPayload(
            case_name="Demo Case",
            brief="A worked example.",
            common_information="Shared background.",
            personas=[factories.persona("A", name="Mary")],
            roots=["A"],
        ),
        owner,
    )
    cleanup.track_case(created.case_id)
    monkeypatch.setattr(case_service, "DEMO_CASE_ID", created.case_id)

    case = (await case_service.getDemoCase(session)).case
    assert case.case_name == "Demo Case"
    assert case.brief == "A worked example."
    assert [persona.name for persona in case.personas] == ["Mary"]


async def test_get_demo_case_leaves_owner_version_and_collaborator_fields_unset(session, cleanup, monkeypatch):
    # The viewer is any signed-in admin, not necessarily someone with access to
    # this case — so the fields that only mean something to a real
    # owner/collaborator must never be populated. getDemoCase shares CaseDetail
    # with getCase (both fields are Optional, default None) rather than a
    # narrower type, so the service-level guarantee is "always None" here; the
    # wire-level guarantee ("absent from the JSON entirely") is enforced by
    # response_model_exclude_none on the /demo route (api/cases.py) and is
    # covered by test_api_contracts.py::test_demo_case_response_omits_null_fields.
    owner = factories.asCurrentAdmin(await cleanup.make_admin())
    created = await case_service.createCase(session, factories.createPayload(case_name="Demo Case"), owner)
    cleanup.track_case(created.case_id)
    monkeypatch.setattr(case_service, "DEMO_CASE_ID", created.case_id)

    case = (await case_service.getDemoCase(session)).case
    assert case.id is None
    assert case.version is None
    assert case.owner_admin_id is None
    assert case.collaborator_admin_ids is None


async def test_get_demo_case_404s_when_not_configured(session, monkeypatch):
    monkeypatch.setattr(case_service, "DEMO_CASE_ID", 999_999_999)
    with pytest.raises(CaseNotFound):
        await case_service.getDemoCase(session)
