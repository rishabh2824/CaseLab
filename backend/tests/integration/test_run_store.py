"""DB-backed tests for services/simulation/run_store.py.

`tests/unit/test_run_store.py` (owned separately) covers the pure `expiry`
helper. Everything here needs a real `simulations` row: JSONB round-tripping
(Run.model_dump(mode="json")/model_validate — the two crossing points that
fully replaced the old hand-rolled serializeRun/deserializeRun), expiry-on-read,
and — the one that actually justifies `with_for_update()` — proof that two
concurrent `updateRun` callers can't stomp on each other's writes.
"""

import asyncio
import time
import uuid

import pytest
from domain_errors import RunNotFound
from infra.db import getSession
from infra.db_models import SimulationRun
from models.runtime import Run, FileRecord
from models.simulations import ChatMessage
from services.simulation import run_store
from tests import factories


def uniqueRunId() -> str:
    return f"run-{uuid.uuid4().hex[:12]}"


def makeRun(**overrides) -> Run:
    """A minimal-but-realistic Run, shaped like services/simulation/state.py
    builds one (see the `run = Run(...)` construction in startSimulation)."""
    overrides.setdefault("start_time", time.time())
    return factories.run(**overrides)


@pytest.fixture
async def runIds():
    """Tracks every simulations.run_id this test created so it can be swept up
    afterward — this table is shared with the running application."""
    ids: list[str] = []
    yield ids
    async with getSession() as session:
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
        shared_files={"7": FileRecord(file_id="7", file_name="doc.pdf", content_type="application/pdf", object_key="obj-7")},
    )

    await run_store.insertRun(run_id, run)
    fetched = await run_store.getRun(run_id)

    # unlocked_referred_ids has no guaranteed order once round-tripped through
    # JSON (Pydantic's set[str] <-> JSON-array conversion doesn't sort), but
    # must come back as an actual Python set, not a list.
    assert fetched.unlocked_referred_ids == {"persona-a", "persona-b"}
    assert isinstance(fetched.unlocked_referred_ids, set)

    # The shared-file record's fields survive the round trip untouched.
    assert fetched.shared_files["7"].file_name == "doc.pdf"
    assert fetched.shared_files["7"].content_type == "application/pdf"

    # A file id used as a dict key must still be a string after the round
    # trip — run.shared_files is keyed by file_id elsewhere in the app
    # (services/simulation/turn.py), and JSON silently stringifies dict
    # keys, which is exactly why resolveFileRef keeps file_id a string
    # from the start.
    (only_key,) = fetched.shared_files.keys()
    assert only_key == "7"
    assert isinstance(only_key, str)


async def test_get_run_missing_id_raises_run_not_found(runIds):
    with pytest.raises(RunNotFound):
        await run_store.getRun(uniqueRunId())


async def test_expired_run_raises_run_not_found_without_deleting_it(runIds):
    run_id = uniqueRunId()
    runIds.append(run_id)
    # start_time far enough in the past that expiry() (start_time + a capped
    # TTL of at most RUN_LIFETIME minutes) is already behind us, regardless
    # of the case_snapshot's simulation_duration.
    run = makeRun(start_time=time.time() - 100_000)
    await run_store.insertRun(run_id, run)

    with pytest.raises(RunNotFound):
        await run_store.getRun(run_id)

    # getRun is a read — it must not have a write side effect. Cleanup is
    # cleanupRuns'/deleteRuns' job, not this GET's.
    async with getSession() as session:
        assert await session.get(SimulationRun, run_id) is not None


async def test_update_run_applies_mutation_persists_it_and_returns_fn_result(runIds):
    run_id = uniqueRunId()
    runIds.append(run_id)
    await run_store.insertRun(run_id, makeRun(active_persona_id="original"))

    def mutate(run: Run):
        run.active_persona_id = "updated"
        return {"echo": "ok"}

    result = await run_store.updateRun(run_id, mutate)
    assert result == {"echo": "ok"}

    fetched = await run_store.getRun(run_id)
    assert fetched.active_persona_id == "updated"


async def test_update_run_row_lock_serializes_concurrent_writers(runIds):
    # updateRun does SELECT ... FOR UPDATE specifically so two concurrent
    # updateRun calls on the same run can't both read-modify-write from the
    # same stale snapshot and silently drop one writer's change. Fire two
    # concurrent appends to the same persona's history and require BOTH to
    # survive — without the row lock, this is a classic lost update and only
    # one would.
    run_id = uniqueRunId()
    runIds.append(run_id)
    await run_store.insertRun(run_id, makeRun())

    def appendMessage(content: str):
        def mutate(run: Run):
            # Mirrors turn_state.appendMessage: _updateRun only flushes messages found
            # in run.pending_messages (see run_store.py) to the run_messages table --
            # since the JSONB-blob-serialized history this test predates, writing
            # straight to run.history alone no longer persists anything.
            message = ChatMessage(role="user", content=content)
            run.history.setdefault("A", []).append(message)
            run.pending_messages.append(("A", message))
            return None

        return mutate

    await asyncio.gather(
        run_store.updateRun(run_id, appendMessage("first")),
        run_store.updateRun(run_id, appendMessage("second")),
    )

    fetched = await run_store.getRun(run_id)
    assert sorted(m.content for m in fetched.history["A"]) == ["first", "second"]


async def test_update_run_missing_id_raises_run_not_found(runIds):
    with pytest.raises(RunNotFound):
        await run_store.updateRun(uniqueRunId(), lambda run: run)


async def test_update_run_expired_raises_run_not_found_and_deletes_it(runIds):
    run_id = uniqueRunId()
    runIds.append(run_id)
    await run_store.insertRun(run_id, makeRun(start_time=time.time() - 100_000))

    with pytest.raises(RunNotFound):
        await run_store.updateRun(run_id, lambda run: run)

    async with getSession() as session:
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

    async with getSession() as session:
        assert await session.get(SimulationRun, stale_id) is None
        assert await session.get(SimulationRun, fresh_id) is not None
