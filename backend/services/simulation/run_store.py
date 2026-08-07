import asyncio
import time
from collections.abc import Callable
from sqlalchemy import delete
from sqlmodel import select
from domain_errors import RunNotFound
from infra.db import getSession
from infra.db_models import RunMessage, SimulationRun
from domain_constants import SIMULATION_DURATION
from models.runtime import Run, RunSnapshot, RunState
from models.simulations import ChatMessage


GRACE_PERIOD = 15 # Grace Period for students to finish up chat after simulation duration is over.
RUN_LIFETIME = SIMULATION_DURATION
RUN_CLEANUP_INTERVAL = 86400  # how often the background sweeper runs

# snapshot (case_snapshot + persona_graph) is write-once after insertRun, so re-validating
# its JSONB through Pydantic on every getRun/updateRun call (up to 3x per message turn:
# prepareTurn's getRun + its start_turn updateRun + applyDecisions' updateRun) is wasted
# work. Cache the parsed RunSnapshot per run_id; entries are dropped wherever a row is
# deleted (updateRun's own expiry branch, deleteRuns' sweep) so the cache never outlives
# the row it mirrors.
_snapshot_cache: dict[str, RunSnapshot] = {}


def _snapshotOf(row: SimulationRun) -> RunSnapshot:
    snapshot = _snapshot_cache.get(row.run_id)
    if snapshot is None:
        snapshot = RunSnapshot.model_validate(row.snapshot)
        _snapshot_cache[row.run_id] = snapshot
    return snapshot


# Absolute unix time at which this run should be deleted.
def expiry(run: Run) -> float:
    duration = run.case_snapshot.simulation_duration
    cap_seconds = RUN_LIFETIME * 60
    if duration: ttl_seconds = min((duration + GRACE_PERIOD) * 60, cap_seconds)
    else: ttl_seconds = cap_seconds
    return run.start_time + ttl_seconds


# Loads a run's transcript from run_messages, grouped by persona. `id` is a
# single global serial, so ordering by it alone preserves each persona's own
# message order too.
#
# `persona_ids` scopes the query: None (the default) loads every persona — the
# only safe choice for a caller that doesn't know in advance who it'll touch.
# A caller that DOES know (getRun/updateRun's callers below) can pass the exact
# set it needs — an empty set skips the query outright. This is a correctness
# contract, not just an optimization: a persona left out of `persona_ids` comes
# back with an empty history, not an error, so only pass a scope you've audited
# every read/write of `run.history` against.
async def _loadHistory(
    session, run_id: str, persona_ids: set[str] | None = None
) -> dict[str, list[ChatMessage]]:
    if persona_ids is not None and not persona_ids:
        return {}
    stmt = select(RunMessage).where(RunMessage.run_id == run_id)
    if persona_ids is not None:
        stmt = stmt.where(RunMessage.persona_id.in_(persona_ids))
    rows = (await session.exec(stmt.order_by(RunMessage.id))).all()
    history: dict[str, list[ChatMessage]] = {}
    for row in rows:
        history.setdefault(row.persona_id, []).append(ChatMessage(role=row.role, content=row.content))
    return history


# Reassembles the flat Run shape service.py/turn_state.py/reads.py expect, from
# the row's snapshot/state columns plus a separately-loaded history dict.
def _compose(row: SimulationRun, history: dict[str, list[ChatMessage]]) -> Run:
    snapshot = _snapshotOf(row)
    state = RunState.model_validate(row.state)
    return Run(
        case_snapshot=snapshot.case_snapshot,
        persona_graph=snapshot.persona_graph,
        start_time=row.start_time,
        active_persona_id=state.active_persona_id,
        unlocked_referred_ids=state.unlocked_referred_ids,
        unlocked_at=state.unlocked_at,
        shared_files=state.shared_files,
        history=history,
        persona_chat_state=state.persona_chat_state,
    )


def _stateOf(run: Run) -> RunState:
    return RunState(
        active_persona_id=run.active_persona_id,
        unlocked_referred_ids=run.unlocked_referred_ids,
        unlocked_at=run.unlocked_at,
        shared_files=run.shared_files,
        persona_chat_state=run.persona_chat_state,
    )


# Insert a freshly-built run under ``run_id``
async def insertRun(run_id: str, run: Run) -> None:
    snapshot = RunSnapshot(case_snapshot=run.case_snapshot, persona_graph=run.persona_graph)
    async with getSession() as session:
        session.add(SimulationRun(
            run_id=run_id,
            start_time=run.start_time,
            expires_at=expiry(run),
            snapshot=snapshot.model_dump(mode="json"),
            state=_stateOf(run).model_dump(mode="json"),
        ))
        await session.commit()


# `session`, when given, is used directly instead of opening a fresh one — lets a caller
# (turn.py's prepareTurn) fold this read into a larger transaction it already holds open,
# instead of paying a separate connection checkout + transaction round trip just for this.
async def getRun(run_id: str, *, persona_ids: set[str] | None = None, session=None) -> Run:
    if session is not None:
        return await _getRun(session, run_id, persona_ids)
    async with getSession() as session:
        return await _getRun(session, run_id, persona_ids)


async def _getRun(session, run_id: str, persona_ids: set[str] | None) -> Run:
    row = await session.get(SimulationRun, run_id)
    if row is None: raise RunNotFound(f"Run {run_id} not found.")
    # A read just returns 404 on an expired row — it does not delete it.
    # cleanupRuns already sweeps expired rows on its own schedule; updateRun
    # deletes eagerly too since it already holds the row locked for a write.
    # Deleting here would make a GET have a write side effect for no benefit.
    if time.time() > row.expires_at:
        raise RunNotFound(f"Run {run_id} expired.")
    history = await _loadHistory(session, run_id, persona_ids)
    return _compose(row, history)


# fn mutates the already-validated Run in place (attribute/dict/set mutation) — no
# re-validation happens between the load and save below (Pydantic v2 doesn't intercept
# attribute reassignment or nested-container mutation unless validate_assignment=True,
# which Run doesn't set). state is always rewritten (cheap — a handful of active
# fields, never the persona graph or full transcript); snapshot/case_id/start_time
# are never touched here regardless of what fn does, since they're write-once. Any
# messages fn appended via turn_state.appendMessage land in run.pending_messages and
# are flushed here as plain INSERTs.
# `session`, same as getRun above — when given, reuses the caller's already-open session/
# transaction instead of checking out a fresh one. Always commits before returning either
# way, since this is always the last DB operation in whatever flow called it.
async def updateRun[T](run_id: str, fn: Callable[[Run], T], *, persona_ids: set[str] | None = None, session=None) -> T:
    if session is not None:
        return await _updateRun(session, run_id, fn, persona_ids)
    async with getSession() as session:
        return await _updateRun(session, run_id, fn, persona_ids)


async def _updateRun[T](session, run_id: str, fn: Callable[[Run], T], persona_ids: set[str] | None) -> T:
    row = (
        await session.exec(
            select(SimulationRun).where(SimulationRun.run_id == run_id).with_for_update()
        )
    ).first()
    if row is None: raise RunNotFound(f"Run {run_id} not found.")
    if time.time() > row.expires_at:
        await session.delete(row)
        await session.commit()
        _snapshot_cache.pop(run_id, None)
        raise RunNotFound(f"Run {run_id} expired.")
    history = await _loadHistory(session, run_id, persona_ids)
    run = _compose(row, history)
    result = fn(run)
    row.state = _stateOf(run).model_dump(mode="json")
    session.add(row)
    if run.pending_messages:
        session.add_all(
            RunMessage(run_id=run_id, persona_id=persona_id, role=message.role, content=message.content)
            for persona_id, message in run.pending_messages
        )
        run.pending_messages.clear()
    await session.commit()
    return result


# Delete every run past its ``expires_at``
async def deleteRuns() -> int:
    async with getSession() as session:
        result = await session.exec(
            delete(SimulationRun).where(SimulationRun.expires_at < time.time()).returning(SimulationRun.run_id)
        )
        deleted_ids = result.scalars().all()
        await session.commit()
        for run_id in deleted_ids:
            _snapshot_cache.pop(run_id, None)
        return len(deleted_ids)


# Background loop that periodically purges expired runs.
async def cleanupRuns(interval: int = RUN_CLEANUP_INTERVAL) -> None:
    while True:
        await asyncio.sleep(interval)
        try: await deleteRuns()
        except Exception: pass
