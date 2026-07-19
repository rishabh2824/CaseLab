
import time
import uuid

import pytest

from services.simulation.run_store import (
    GRACE_PERIOD,
    expiry,
    deserializeRun,
    serializeRun,
    insertRun,
    getRun,
    updateRun,
    deleteRuns,
)
from infra.settings import SIMULATION_DURATION


def run(**over):
    base = {
        "case_id": "c1",
        "case_snapshot": {"simulation_duration": 45},
        # Near-now so the computed expiry lands in the future (RunStore.get_row
        # treats a past expiry as expired). compute_expiry tests below pin
        # start_time explicitly instead.
        "start_time": time.time(),
        "unlocked_referred_ids": {"a", "b"},
        "unlocked_at": {"a": 3},
        "shared_files": {},
        "history": {"p1": [{"role": "user", "content": "hi"}]},
        "persona_chat_state": {},
        "notes": "",
    }
    base.update(over)
    return base


def expired_run(**over):
    # A huge negative start_time offset guarantees expires_at is in the past
    # regardless of the (uncapped) TTL, without needing to poke at storage directly.
    return run(start_time=time.time() - 10_000_000, case_snapshot={"simulation_duration": None}, **over)


# --- serialize / deserialize ------------------------------------------------
class TestSerialization:
    def test_round_trip_preserves_run(self):
        run_data = run()
        restored = deserializeRun(serializeRun(run_data))
        assert restored == run_data

    def test_unlocked_ids_survive_as_a_set(self):
        run_data = run(unlocked_referred_ids={"x", "y", "z"})
        restored = deserializeRun(serializeRun(run_data))
        assert restored["unlocked_referred_ids"] == {"x", "y", "z"}
        assert isinstance(restored["unlocked_referred_ids"], set)

    def test_empty_unlocked_ids_round_trip(self):
        run_data = run(unlocked_referred_ids=set())
        restored = deserializeRun(serializeRun(run_data))
        assert restored["unlocked_referred_ids"] == set()

    def test_serialized_form_has_sorted_id_list(self):
        # serialize_run returns a JSONB-ready dict (not a JSON string) — the
        # data column is JSONB, so there's no json.dumps step to round-trip here.
        run_data = run(unlocked_referred_ids={"b", "a", "c"})
        payload = serializeRun(run_data)
        assert payload["unlocked_referred_ids"] == ["a", "b", "c"]


# --- compute_expiry ---------------------------------------------------------
class TestComputeExpiry:
    def test_duration_plus_grace(self):
        run_data = run(start_time=1000.0, case_snapshot={"simulation_duration": 45})
        expected = 1000.0 + (45 + GRACE_PERIOD) * 60
        assert expiry(run_data) == expected

    def test_capped_at_max_lifetime(self):
        # a duration near the cap + grace must not exceed MAX_SIMULATION_DURATION.
        run_data = run(start_time=0.0, case_snapshot={"simulation_duration": SIMULATION_DURATION})
        assert expiry(run_data) == SIMULATION_DURATION * 60

    def test_missing_duration_uses_cap(self):
        run_data = run(start_time=0.0, case_snapshot={})
        assert expiry(run_data) == SIMULATION_DURATION * 60


# --- run_store (async, real Postgres in a rolled-back transaction) ---------
def run_id() -> str:
    return f"test-{uuid.uuid4().hex}"


@pytest.mark.usefixtures("db_session")
class TestRunStore:
    async def test_put_then_get_round_trips(self):
        rid = run_id()
        run_data = run()
        await insertRun(rid, run_data)
        loaded = await getRun(rid)
        assert loaded == run_data

    async def test_get_missing_raises_not_found(self):
        with pytest.raises(ValueError, match="not found"):
            await getRun(run_id())

    async def test_get_expired_raises_and_deletes(self):
        rid = run_id()
        await insertRun(rid, expired_run())
        with pytest.raises(ValueError, match="expired"):
            await getRun(rid)
        # cleaned up on read - a second get sees no row at all, not another expiry
        with pytest.raises(ValueError, match="not found"):
            await getRun(rid)

    async def test_mutate_persists(self):
        rid = run_id()
        await insertRun(rid, run(notes=""))

        def set_notes(r):
            r["notes"] = "hello"
            return r["notes"]

        result = await updateRun(rid, set_notes)
        assert result == "hello"
        assert (await getRun(rid))["notes"] == "hello"

    async def test_mutate_missing_raises_not_found(self):
        with pytest.raises(ValueError, match="not found"):
            await updateRun(run_id(), lambda r: None)

    async def test_mutate_expired_raises_and_deletes(self):
        rid = run_id()
        await insertRun(rid, expired_run())
        with pytest.raises(ValueError, match="expired"):
            await updateRun(rid, lambda r: r)

    async def test_purge_expired_deletes_only_stale_rows(self):
        fresh_id, stale_id = run_id(), run_id()
        await insertRun(fresh_id, run(case_snapshot={"simulation_duration": None}))
        await insertRun(stale_id, expired_run())

        deleted = await deleteRuns()
        assert deleted >= 1
        assert (await getRun(fresh_id))["case_id"] == "c1"
        with pytest.raises(ValueError, match="not found"):
            await getRun(stale_id)
