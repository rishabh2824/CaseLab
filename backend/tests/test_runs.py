"""RunStore: serialization round-trips, expiry, and optimistic-locking mutate."""

import time

import pytest

from Queries.simulation import runs as runs_module
from Queries.simulation.runs import (
    RUN_TTL_GRACE_MINUTES,
    RunExpired,
    RunNotFound,
    RunStore,
    RunWriteConflict,
    compute_expiry,
    deserialize_run,
    serialize_run,
)
from infra.settings import MAX_SIMULATION_DURATION


def _run(**over):
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


# --- serialize / deserialize ------------------------------------------------
class TestSerialization:
    def test_round_trip_preserves_run(self):
        run = _run()
        restored = deserialize_run(serialize_run(run))
        assert restored == run

    def test_unlocked_ids_survive_as_a_set(self):
        run = _run(unlocked_referred_ids={"x", "y", "z"})
        restored = deserialize_run(serialize_run(run))
        assert restored["unlocked_referred_ids"] == {"x", "y", "z"}
        assert isinstance(restored["unlocked_referred_ids"], set)

    def test_empty_unlocked_ids_round_trip(self):
        run = _run(unlocked_referred_ids=set())
        restored = deserialize_run(serialize_run(run))
        assert restored["unlocked_referred_ids"] == set()

    def test_serialized_form_is_json_with_sorted_id_list(self):
        import json

        run = _run(unlocked_referred_ids={"b", "a", "c"})
        payload = json.loads(serialize_run(run))
        assert payload["unlocked_referred_ids"] == ["a", "b", "c"]


# --- compute_expiry ---------------------------------------------------------
class TestComputeExpiry:
    def test_duration_plus_grace(self):
        run = _run(start_time=1000.0, case_snapshot={"simulation_duration": 45})
        expected = 1000.0 + (45 + RUN_TTL_GRACE_MINUTES) * 60
        assert compute_expiry(run) == expected

    def test_capped_at_max_lifetime(self):
        # a duration near the cap + grace must not exceed MAX_SIMULATION_DURATION.
        run = _run(start_time=0.0, case_snapshot={"simulation_duration": MAX_SIMULATION_DURATION})
        assert compute_expiry(run) == MAX_SIMULATION_DURATION * 60

    def test_missing_duration_uses_cap(self):
        run = _run(start_time=0.0, case_snapshot={})
        assert compute_expiry(run) == MAX_SIMULATION_DURATION * 60


# --- RunStore (async, fake DB) ---------------------------------------------
@pytest.fixture
def store(monkeypatch, fake_client):
    # RunStore.* call getDb() internally; point it at the in-memory fake.
    monkeypatch.setattr(runs_module, "getDb", lambda: fake_client)
    return RunStore(), fake_client


class TestRunStore:
    async def test_put_then_get_round_trips(self, store):
        s, _client = store
        run = _run()
        await s.put("run1", run)
        loaded = await s.get("run1")
        assert loaded == run

    async def test_get_missing_raises_not_found(self, store):
        s, _client = store
        with pytest.raises(RunNotFound):
            await s.get("nope")

    async def test_get_expired_raises_and_deletes(self, store):
        s, client = store
        run = _run(start_time=time.time() - 10, case_snapshot={"simulation_duration": None})
        await s.put("run1", run)
        # force the stored row's expiry into the past
        client.rows["run1"]["expires_at"] = time.time() - 1
        with pytest.raises(RunExpired):
            await s.get("run1")
        assert "run1" not in client.rows  # cleaned up on read

    async def test_mutate_persists_and_increments_version(self, store):
        s, client = store
        await s.put("run1", _run(notes=""))

        def set_notes(r):
            r["notes"] = "hello"
            return r["notes"]

        result = await s.mutate("run1", set_notes)
        assert result == "hello"
        assert client.rows["run1"]["version"] == 1
        assert (await s.get("run1"))["notes"] == "hello"

    async def test_mutate_missing_raises_not_found(self, store):
        s, _client = store

        with pytest.raises(RunNotFound):
            await s.mutate("nope", lambda r: None)

    async def test_mutate_raises_conflict_when_writes_never_land(self, store, monkeypatch):
        s, client = store
        await s.put("run1", _run())

        # Simulate a perpetually-racing writer: every versioned UPDATE affects 0
        # rows, so mutate exhausts its retries and surfaces a write conflict.
        real_execute = client.execute

        async def losing_execute(sql, params=()):
            result = await real_execute(sql, params)
            if " ".join(sql.split()).lower().startswith("update simulation_runs set data"):
                result.rows_affected = 0
            return result

        monkeypatch.setattr(client, "execute", losing_execute)

        with pytest.raises(RunWriteConflict):
            await s.mutate("run1", lambda r: r, max_retries=3)

    async def test_purge_expired_deletes_only_stale_rows(self, store):
        s, client = store
        await s.put("fresh", _run(case_snapshot={"simulation_duration": None}))
        await s.put("stale", _run(case_snapshot={"simulation_duration": None}))
        client.rows["stale"]["expires_at"] = time.time() - 1

        deleted = await s.purge_expired()
        assert deleted == 1
        assert "fresh" in client.rows
        assert "stale" not in client.rows
