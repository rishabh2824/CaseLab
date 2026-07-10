"""Case ownership filtering/authorization in case_service — the logic behind
"a regular admin only sees their own cases; a super admin sees everything."

The DB layer (case_repository / get_db_client) is mocked throughout, same as
test_dependencies.py: what's under test is case_service's own decisions about
which owner_admin_id to filter by and when to raise 403, not SQL or a real
database.
"""

import pytest
from fastapi import HTTPException

from api.dependencies import CurrentAdmin
from models.cases import CasePayload
from services import case_service
from tests.conftest import async_return

REGULAR_ADMIN = CurrentAdmin(id="admin-1", role=2)
OTHER_ADMIN = CurrentAdmin(id="admin-2", role=2)
SUPER_ADMIN = CurrentAdmin(id="super-1", role=1)


def _payload(**overrides):
    fields = {
        "caseName": "Test Case",
        "initialBrief": "Brief",
        "totalNonReferredPersonas": 1,
        **overrides,
    }
    return CasePayload(**fields)


def _case_row(case_id="case-1", owner_admin_id="admin-1"):
    return {
        "id": case_id,
        "case_name": "Test Case",
        "access_code": None,
        "initial_brief": "Brief",
        "common_information": None,
        "simulation_duration": None,
        "non_referred": 1,
        "owner_admin_id": owner_admin_id,
    }


@pytest.fixture(autouse=True)
def _patch_db_client(monkeypatch):
    monkeypatch.setattr(case_service, "get_db_client", lambda: object())


@pytest.fixture(autouse=True)
def _patch_persona_assembly(monkeypatch):
    # Persona-tree assembly is a separate concern from ownership; stub it out
    # so get_case tests only exercise the authorization decision.
    monkeypatch.setattr(case_service, "build_case_personas", async_return(lambda client, case_id: []))


# --- list_cases: filtering ---------------------------------------------


async def test_list_cases_filters_to_own_cases_for_regular_admin(monkeypatch):
    captured = {}

    async def fake_fetch_cases(client, owner_admin_id=None):
        captured["owner_admin_id"] = owner_admin_id
        return []

    monkeypatch.setattr(case_service.repo, "fetch_cases", fake_fetch_cases)

    await case_service.list_cases(REGULAR_ADMIN)

    assert captured["owner_admin_id"] == "admin-1"


async def test_list_cases_returns_everything_for_super_admin(monkeypatch):
    captured = {}

    async def fake_fetch_cases(client, owner_admin_id=None):
        captured["owner_admin_id"] = owner_admin_id
        return []

    monkeypatch.setattr(case_service.repo, "fetch_cases", fake_fetch_cases)

    await case_service.list_cases(SUPER_ADMIN)

    assert captured["owner_admin_id"] is None


# --- get_case: authorization ---------------------------------------------


async def test_get_case_404_when_case_does_not_exist(monkeypatch):
    monkeypatch.setattr(case_service.repo, "fetch_case", async_return(lambda c, cid: None))

    with pytest.raises(HTTPException) as exc_info:
        await case_service.get_case("missing", REGULAR_ADMIN)
    assert exc_info.value.status_code == 404


async def test_get_case_allowed_for_owning_admin(monkeypatch):
    row = _case_row(owner_admin_id="admin-1")
    monkeypatch.setattr(case_service.repo, "fetch_case", async_return(lambda c, cid: row))

    result = await case_service.get_case("case-1", REGULAR_ADMIN)

    assert result["case"]["id"] == "case-1"


async def test_get_case_forbidden_for_non_owning_admin(monkeypatch):
    row = _case_row(owner_admin_id="admin-1")
    monkeypatch.setattr(case_service.repo, "fetch_case", async_return(lambda c, cid: row))

    with pytest.raises(HTTPException) as exc_info:
        await case_service.get_case("case-1", OTHER_ADMIN)
    assert exc_info.value.status_code == 403


async def test_get_case_allowed_for_super_admin_regardless_of_owner(monkeypatch):
    row = _case_row(owner_admin_id="admin-1")
    monkeypatch.setattr(case_service.repo, "fetch_case", async_return(lambda c, cid: row))

    result = await case_service.get_case("case-1", SUPER_ADMIN)

    assert result["case"]["id"] == "case-1"


async def test_get_case_forbidden_for_regular_admin_on_legacy_unowned_case(monkeypatch):
    # owner_admin_id NULL == legacy case predating this feature — visible
    # only to super admins, per the plan ("no invented ownership").
    row = _case_row(owner_admin_id=None)
    monkeypatch.setattr(case_service.repo, "fetch_case", async_return(lambda c, cid: row))

    with pytest.raises(HTTPException) as exc_info:
        await case_service.get_case("case-1", REGULAR_ADMIN)
    assert exc_info.value.status_code == 403


async def test_get_case_allowed_for_super_admin_on_legacy_unowned_case(monkeypatch):
    row = _case_row(owner_admin_id=None)
    monkeypatch.setattr(case_service.repo, "fetch_case", async_return(lambda c, cid: row))

    result = await case_service.get_case("case-1", SUPER_ADMIN)

    assert result["case"]["id"] == "case-1"


# --- update_case: authorization ---------------------------------------------


async def test_update_case_404_when_case_does_not_exist(monkeypatch):
    monkeypatch.setattr(case_service.repo, "fetch_case_owner", async_return(lambda c, cid: None))

    with pytest.raises(HTTPException) as exc_info:
        await case_service.update_case("missing", _payload(), REGULAR_ADMIN)
    assert exc_info.value.status_code == 404


async def test_update_case_forbidden_for_non_owning_admin(monkeypatch):
    monkeypatch.setattr(
        case_service.repo,
        "fetch_case_owner",
        async_return(lambda c, cid: {"id": cid, "owner_admin_id": "admin-1"}),
    )
    batch_called = []
    fake_client = type("C", (), {"batch": staticmethod(async_return(lambda stmts: batch_called.append(stmts)))})()
    monkeypatch.setattr(case_service, "get_db_client", lambda: fake_client)

    with pytest.raises(HTTPException) as exc_info:
        await case_service.update_case("case-1", _payload(), OTHER_ADMIN)

    assert exc_info.value.status_code == 403
    assert batch_called == []  # never got as far as writing


async def test_update_case_allowed_for_owning_admin(monkeypatch):
    monkeypatch.setattr(
        case_service.repo,
        "fetch_case_owner",
        async_return(lambda c, cid: {"id": cid, "owner_admin_id": "admin-1"}),
    )
    monkeypatch.setattr(case_service.repo, "access_code_taken", async_return(lambda *a, **k: False))
    monkeypatch.setattr(
        case_service.repo, "update_case_fields", lambda case_id, payload: ("update sql", ())
    )
    monkeypatch.setattr(
        case_service.repo, "delete_personas_for_case", lambda case_id: ("delete sql", ())
    )
    batch_called = []
    fake_client = type(
        "C", (), {"batch": staticmethod(async_return(lambda stmts: batch_called.append(stmts)))}
    )()
    monkeypatch.setattr(case_service, "get_db_client", lambda: fake_client)

    result = await case_service.update_case("case-1", _payload(), REGULAR_ADMIN)

    assert result == {"case_id": "case-1"}
    assert len(batch_called) == 1


async def test_update_case_allowed_for_super_admin_on_others_case(monkeypatch):
    monkeypatch.setattr(
        case_service.repo,
        "fetch_case_owner",
        async_return(lambda c, cid: {"id": cid, "owner_admin_id": "admin-1"}),
    )
    monkeypatch.setattr(case_service.repo, "access_code_taken", async_return(lambda *a, **k: False))
    monkeypatch.setattr(
        case_service.repo, "update_case_fields", lambda case_id, payload: ("update sql", ())
    )
    monkeypatch.setattr(
        case_service.repo, "delete_personas_for_case", lambda case_id: ("delete sql", ())
    )
    fake_client = type("C", (), {"batch": staticmethod(async_return(lambda stmts: None))})()
    monkeypatch.setattr(case_service, "get_db_client", lambda: fake_client)

    result = await case_service.update_case("case-1", _payload(), SUPER_ADMIN)

    assert result == {"case_id": "case-1"}


# --- create_case: ownership stamping ---------------------------------------------


async def test_create_case_stamps_owner_admin_id(monkeypatch):
    monkeypatch.setattr(case_service.repo, "access_code_taken", async_return(lambda *a, **k: False))
    captured = {}

    def fake_insert_case(case_id, payload, owner_admin_id):
        captured["owner_admin_id"] = owner_admin_id
        return ("insert sql", ())

    monkeypatch.setattr(case_service.repo, "insert_case", fake_insert_case)
    fake_client = type("C", (), {"batch": staticmethod(async_return(lambda stmts: None))})()
    monkeypatch.setattr(case_service, "get_db_client", lambda: fake_client)

    await case_service.create_case(_payload(), REGULAR_ADMIN)

    assert captured["owner_admin_id"] == "admin-1"
