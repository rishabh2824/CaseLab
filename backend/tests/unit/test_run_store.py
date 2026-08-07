"""services/simulation/run_store.py — the pure expiry helper, with no
database involved. insertRun/getRun/updateRun open a real session and are out
of scope here (exercised end-to-end via the `sim` fixture elsewhere); the
JSONB set<->list round trip (Run.model_dump(mode="json")/model_validate,
which fully replaced the old hand-rolled serializeRun/deserializeRun) is
exercised against a real Postgres row by tests/integration/test_run_store.py.
"""

from __future__ import annotations

from models.runtime import CaseSnapshot
from services.simulation import run_store
from tests import factories


def test_expiry_uses_duration_plus_grace_period():
    run = factories.run(case_snapshot=CaseSnapshot(id=1, case_name="C", brief="B", simulation_duration=10))
    expected = 1000.0 + (10 + run_store.GRACE_PERIOD) * 60
    assert run_store.expiry(run) == expected


def test_expiry_caps_at_run_lifetime_for_a_long_duration():
    run = factories.run(
        case_snapshot=CaseSnapshot(
            id=1, case_name="C", brief="B", simulation_duration=run_store.RUN_LIFETIME * 10
        )
    )
    expected = 1000.0 + run_store.RUN_LIFETIME * 60
    assert run_store.expiry(run) == expected


def test_expiry_falls_back_to_the_cap_when_case_has_no_duration():
    run = factories.run(case_snapshot=CaseSnapshot(id=1, case_name="C", brief="B", simulation_duration=None))
    assert run_store.expiry(run) == 1000.0 + run_store.RUN_LIFETIME * 60
