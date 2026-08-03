import asyncio
import pytest
from domain_errors import AccessDenied, CaseNotFound, VersionConflict
from infra.db import getSession
from services import cases as case_service
from tests.factories import asCurrentAdmin, createPayload, updatePayload


async def test_correct_version_succeeds_and_increments(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    created = await case_service.createCase(session, createPayload(), owner)
    case_id = created["case_id"]
    cleanup.track_case(case_id)

    await case_service.updateCase(session, case_id, updatePayload(1, case_name="Renamed"), owner)

    detail = await case_service.getCase(session, case_id, owner)
    assert detail["case"]["version"] == 2
    assert detail["case"]["case_name"] == "Renamed"


async def test_stale_version_is_rejected_and_row_is_unchanged(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    created = await case_service.createCase(session, createPayload(), owner)
    case_id = created["case_id"]
    cleanup.track_case(case_id)

    # First save succeeds and bumps the row to version 2.
    await case_service.updateCase(session, case_id, updatePayload(1, case_name="First Save"), owner)

    # A second save that still thinks the version is 1 must be rejected —
    # nothing about the row (including structure/name) may change.
    with pytest.raises(VersionConflict) as exc_info:
        await case_service.updateCase(session, case_id, updatePayload(1, case_name="Stale Save"), owner)
    assert exc_info.value.detail["code"] == "version_conflict"

    detail = await case_service.getCase(session, case_id, owner)
    assert detail["case"]["case_name"] == "First Save"
    assert detail["case"]["version"] == 2


async def test_concurrent_saves_against_real_postgres_only_one_wins(cleanup):
    # The whole point of the version column is a DB-level compare-and-swap, so
    # this drives two genuinely separate sessions/connections at once (not the
    # shared `session` fixture) to prove Postgres itself — not just application
    # code — prevents the lost-update race.
    owner_admin = await cleanup.make_admin()
    owner = asCurrentAdmin(owner_admin)

    async with getSession() as setup_session:
        created = await case_service.createCase(setup_session, createPayload(), owner)
    case_id = created["case_id"]
    cleanup.track_case(case_id)

    async def attempt(case_name: str):
        async with getSession() as session:
            try:
                await case_service.updateCase(session, case_id, updatePayload(1, case_name=case_name), owner)
                return "ok"
            except VersionConflict as exc:
                return exc.status_code

    results = await asyncio.gather(attempt("Admin A wins"), attempt("Admin B loses"))
    assert sorted(results, key=str) == sorted(["ok", 409], key=str)

    async with getSession() as verify_session:
        detail = await case_service.getCase(verify_session, case_id, owner)
    assert detail["case"]["version"] == 2
    assert detail["case"]["case_name"] in ("Admin A wins", "Admin B loses")


async def test_get_case_version_respects_access_control(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    stranger = asCurrentAdmin(await cleanup.make_admin())

    created = await case_service.createCase(session, createPayload(), owner)
    case_id = created["case_id"]
    cleanup.track_case(case_id)

    result = await case_service.getCaseVersion(session, case_id, owner)
    assert result["version"] == 1

    with pytest.raises(AccessDenied):
        await case_service.getCaseVersion(session, case_id, stranger)

    with pytest.raises(CaseNotFound):
        await case_service.getCaseVersion(session, 999_999_999, owner)
