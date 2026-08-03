"""DB-backed tests for services/simulation/run_store.py.

`tests/unit/test_run_store.py` (owned separately) covers the pure
serializeRun/deserializeRun functions. Everything here needs a real
`simulations` row: JSONB round-tripping, expiry-on-read, and — the one that
actually justifies `with_for_update()` — proof that two concurrent
`updateRun` callers can't stomp on each other's writes.
"""

import asyncio
import time
import uuid

import pytest
from domain_errors import RunNotFound
from infra.db import get_session
from infra.db_models import SimulationRun
from services.simulation import run_store


def uniqueRunId() -> str:
    return f"run-{uuid.uuid4().hex[:12]}"


def makeRun(**overrides) -> dict:
    """A minimal-but-realistic run blob, shaped like services/simulation/service.py
    builds one (see the `run = {...}` literal in startSimulation)."""
    base: dict = dict(
        case_id=1,
        case_snapshot={"simulation_duration": None},
        start_time=time.time(),
        active_persona_id="A",
        unlocked_referred_ids=set(),
        unlocked_at={},
        shared_files={},
        history={},
        persona_chat_state={},
        notes="",
        tags=[],
    )
    base.update(overrides)
    return base


@pytest.fixture
async def runIds():
    """Tracks every simulations.run_id this test created so it can be swept up
    afterward — this table is shared with the running application."""
    ids: list[str] = []
    yield ids
    async with get_session() as session:
        for run_id in ids:
            row = await session.get(SimulationRun, run_id)
            if row is not None:
                await session.delete(row)
        await session.commit()


async def test_insert_then_get_round_trips_through_jsonb(runIds):
    run_id = uniqueRunId()
    runIds.append(run_id)
    run = makeRun(
        unlocked_referred_ids={"persona-a", "persona-b"},
        shared_files={"7": {"file_id": "7", "nested": {"k": "v"}}},
    )

    await run_store.insertRun(run_id, run)
    fetched = await run_store.getRun(run_id)

    # unlocked_referred_ids is stored as a sorted list (JSON has no set type)
    # and must come back as an actual Python set, not a list.
    assert fetched["unlocked_referred_ids"] == {"persona-a", "persona-b"}
    assert isinstance(fetched["unlocked_referred_ids"], set)

    # Nested dicts inside the JSONB blob survive the round trip untouched.
    assert fetched["shared_files"]["7"]["nested"] == {"k": "v"}

    # A file id used as a dict key must still be a string after the round
    # trip — run["shared_files"] is keyed by file_id elsewhere in the app
    # (services/simulation/service.py), and JSON silently stringifies dict
    # keys, which is exactly why resolve_file_ref keeps file_id a string
    # from the start.
    (only_key,) = fetched["shared_files"].keys()
    assert only_key == "7"
    assert isinstance(only_key, str)


async def test_get_run_missing_id_raises_run_not_found(runIds):
    with pytest.raises(RunNotFound):
        await run_store.getRun(uniqueRunId())


async def test_expired_run_is_deleted_on_read_and_raises_run_not_found(runIds):
    run_id = uniqueRunId()
    runIds.append(run_id)  # defensive: getRun should already delete it
    # start_time far enough in the past that expiry() (start_time + a capped
    # TTL of at most RUN_LIFETIME minutes) is already behind us, regardless
    # of the case_snapshot's simulation_duration.
    run = makeRun(start_time=time.time() - 100_000)
    await run_store.insertRun(run_id, run)

    with pytest.raises(RunNotFound):
        await run_store.getRun(run_id)

    # getRun deletes the expired row itself, not merely treats it as absent.
    async with get_session() as session:
        assert await session.get(SimulationRun, run_id) is None


async def test_update_run_applies_mutation_persists_it_and_returns_fn_result(runIds):
    run_id = uniqueRunId()
    runIds.append(run_id)
    await run_store.insertRun(run_id, makeRun(notes="original"))

    def mutate(run: dict):
        run["notes"] = "updated"
        return {"echo": "ok"}

    result = await run_store.updateRun(run_id, mutate)
    assert result == {"echo": "ok"}

    fetched = await run_store.getRun(run_id)
    assert fetched["notes"] == "updated"


async def test_update_run_row_lock_serializes_concurrent_writers(runIds):
    # updateRun does SELECT ... FOR UPDATE specifically so two concurrent
    # updateRun calls on the same run can't both read-modify-write from the
    # same stale snapshot and silently drop one writer's change. Fire two
    # concurrent appends to the same list and require BOTH to survive —
    # without the row lock, this is a classic lost update and only one would.
    run_id = uniqueRunId()
    runIds.append(run_id)
    await run_store.insertRun(run_id, makeRun(tags=[]))

    def appendTag(value: str):
        def mutate(run: dict):
            run.setdefault("tags", []).append(value)
            return None

        return mutate

    await asyncio.gather(
        run_store.updateRun(run_id, appendTag("first")),
        run_store.updateRun(run_id, appendTag("second")),
    )

    fetched = await run_store.getRun(run_id)
    assert sorted(fetched["tags"]) == ["first", "second"]


async def test_update_run_missing_id_raises_run_not_found(runIds):
    with pytest.raises(RunNotFound):
        await run_store.updateRun(uniqueRunId(), lambda run: run)


async def test_update_run_expired_raises_run_not_found_and_deletes_it(runIds):
    run_id = uniqueRunId()
    runIds.append(run_id)
    await run_store.insertRun(run_id, makeRun(start_time=time.time() - 100_000))

    with pytest.raises(RunNotFound):
        await run_store.updateRun(run_id, lambda run: run)

    async with get_session() as session:
        assert await session.get(SimulationRun, run_id) is None


async def test_delete_runs_removes_only_expired_rows_and_returns_a_count(runIds):
    fresh_id = uniqueRunId()
    stale_id = uniqueRunId()
    runIds.extend([fresh_id, stale_id])
    await run_store.insertRun(fresh_id, makeRun(start_time=time.time()))
    await run_store.insertRun(stale_id, makeRun(start_time=time.time() - 100_000))

    deleted = await run_store.deleteRuns()
    # deleteRuns sweeps the whole shared table, so other stale rows may
    # legitimately exist alongside ours — just require ours was counted.
    assert deleted >= 1

    async with get_session() as session:
        assert await session.get(SimulationRun, stale_id) is None
        assert await session.get(SimulationRun, fresh_id) is not None
