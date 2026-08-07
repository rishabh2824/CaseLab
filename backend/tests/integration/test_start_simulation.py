"""DB-backed test for POST /simulations/start (services/simulation/state.py's
startSimulation).

Nothing else covered this path against a real session: tests/unit/conftest.py's
`sim` fixture patches `reads.fetchCase` wholesale and hands startSimulation a
fake `None` session, so the real getCaseWithGraph -> fetchCase -> ORM chain was
never exercised. That's exactly the gap that let a load_only column projection
on the access-code fetch (added to skip pulling the large `structure` JSONB)
ship a MissingGreenlet crash on every single call: a second, separate fetch by
case_id landed on the session's identity map instead of re-querying, returning
the same Case row with `structure` still deferred -- and reading a deferred
column outside an awaited ORM call has no greenlet to bridge into.
"""

import uuid

import pytest
from domain_errors import CaseNotFound
from infra.db import getSession
from infra.db_models import RateLimit, SimulationRun
from models.simulations import StartSimulation
from services import cases as case_service
from services.simulation import state as state_module
from tests import factories


# startSimulation calls simulationLimit, which goes through infra.rate_limit_repo
# the same way test_rate_limit.py's own tests do — same exemption, same reason
# (see that file's comment): session.exec() can't express upsertAndGet's
# RETURNING clause, so this file needs the session.execute() deprecation
# silenced too.
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning:infra.rate_limit_repo")


def uniqueAccessCode() -> str:
    return f"SIM-{uuid.uuid4().hex[:12].upper()}"


@pytest.fixture
async def startedRuns():
    """Tracks every simulations.run_id and rate_limits key this test created,
    same cleanup convention as test_run_store.py / test_rate_limit.py — both
    tables are shared with the running application."""
    run_ids: list[str] = []
    rate_limit_keys: list[str] = []
    yield run_ids, rate_limit_keys

    async with getSession() as session:
        for run_id in run_ids:
            row = await session.get(SimulationRun, run_id)
            if row is not None:
                await session.delete(row)
        await session.commit()

        for key in rate_limit_keys:
            row = await session.get(RateLimit, key)
            if row is not None:
                await session.delete(row)
        await session.commit()


async def test_start_simulation_against_real_session_does_not_crash(session, cleanup, startedRuns):
    run_ids, rate_limit_keys = startedRuns
    owner = factories.asCurrentAdmin(await cleanup.make_admin())
    access_code = uniqueAccessCode()
    payload = factories.createPayload(
        access_code=access_code,
        personas=[factories.persona("A", name="Root Persona")],
        referrals=[],
        roots=["A"],
    )

    created = await case_service.createCase(session, payload, owner)
    cleanup.track_case(created.case_id)
    await session.commit()

    rate_limit_keys.append(f"start:{access_code.strip().upper()}")

    # This is the exact call the API layer makes for POST /simulations/start.
    # Before the fix, the access-code fetch deferred `structure` via load_only
    # and a *second* fetchCase(case_id=...) call hit the session's identity map
    # instead of re-querying, so it returned the same still-deferred Case
    # instance. Reading case.structure off it to build the persona graph then
    # raised MissingGreenlet.
    run_state = await state_module.startSimulation(StartSimulation(access_code=access_code))
    run_ids.append(run_state.run_id)

    assert run_state.case.id == created.case_id
    assert run_state.active_persona_id == "A"
    assert [c.id for c in run_state.contacts] == ["A"]
    assert run_state.contacts[0].name == "Root Persona"


async def test_start_simulation_with_unknown_access_code_raises_case_not_found(startedRuns):
    with pytest.raises(CaseNotFound):
        await state_module.startSimulation(StartSimulation(access_code=uniqueAccessCode()))
