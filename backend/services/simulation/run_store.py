import asyncio
import time
from collections.abc import Callable
from sqlalchemy import delete
from sqlmodel import select
from domain_errors import RunNotFound
from infra.db import getSession
from infra.db_models import RunMessage, SimulationRun
from domain_constants import SIMULATION_DURATION
from models.simulation_runtime import Run, RunSnapshot, RunState
from models.simulations import ChatMessage


GRACE_PERIOD = 15 # Grace Period for students to save notes / chat after simulation duration is over.
RUN_LIFETIME = SIMULATION_DURATION
RUN_CLEANUP_INTERVAL = 86400  # how often the background sweeper runs


# Absolute unix time at which this run should be deleted.
def expiry(run: Run) -> float:
    duration = run.case_snapshot.simulation_duration
    cap_seconds = RUN_LIFETIME * 60
    if duration: ttl_seconds = min((duration + GRACE_PERIOD) * 60, cap_seconds)
    else: ttl_seconds = cap_seconds
    return run.start_time + ttl_seconds


# Loads a run's full transcript from run_messages, grouped by persona. `id` is a
# single global serial, so ordering by it alone preserves each persona's own
# message order too.
async def _loadHistory(session, run_id: str) -> dict[str, list[ChatMessage]]:
    rows = (
        await session.exec(
            select(RunMessage).where(RunMessage.run_id == run_id).order_by(RunMessage.id)
        )
    ).all()
    history: dict[str, list[ChatMessage]] = {}
    for row in rows:
        history.setdefault(row.persona_id, []).append(ChatMessage(role=row.role, content=row.content))
    return history


# Reassembles the flat Run shape service.py/turn_state.py/reads.py expect, from
# the row's snapshot/state columns plus a separately-loaded history dict.
def _compose(row: SimulationRun, history: dict[str, list[ChatMessage]]) -> Run:
    snapshot = RunSnapshot.model_validate(row.snapshot)
    state = RunState.model_validate(row.state)
    return Run(
        case_id=row.case_id,
        case_snapshot=snapshot.case_snapshot,
        persona_graph=snapshot.persona_graph,
        start_time=row.start_time,
        active_persona_id=state.active_persona_id,
        unlocked_referred_ids=state.unlocked_referred_ids,
        unlocked_at=state.unlocked_at,
        shared_files=state.shared_files,
        history=history,
        persona_chat_state=state.persona_chat_state,
        notes=row.notes,
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
            case_id=run.case_id,
            start_time=run.start_time,
            expires_at=expiry(run),
            snapshot=snapshot.model_dump(mode="json"),
            state=_stateOf(run).model_dump(mode="json"),
            notes=run.notes,
        ))
        await session.commit()


async def getRun(run_id: str) -> Run:
    async with getSession() as session:
        row = await session.get(SimulationRun, run_id)
        if row is None: raise RunNotFound(f"Run {run_id} not found.")
        if time.time() > row.expires_at:
            await session.delete(row)
            await session.commit()
            raise RunNotFound(f"Run {run_id} expired.")
        history = await _loadHistory(session, run_id)
        return _compose(row, history)


# fn mutates the already-validated Run in place (attribute/dict/set mutation) — no
# re-validation happens between the load and save below (Pydantic v2 doesn't intercept
# attribute reassignment or nested-container mutation unless validate_assignment=True,
# which Run doesn't set). state/notes are always rewritten (both are cheap — a handful
# of active fields, never the persona graph or full transcript); snapshot/case_id/
# start_time are never touched here regardless of what fn does, since they're
# write-once. Any messages fn appended via turn_state.appendMessage land in
# run.pending_messages and are flushed here as plain INSERTs.
async def updateRun[T](run_id: str, fn: Callable[[Run], T]) -> T:
    async with getSession() as session:
        row = (
            await session.exec(
                select(SimulationRun).where(SimulationRun.run_id == run_id).with_for_update()
            )
        ).first()
        if row is None: raise RunNotFound(f"Run {run_id} not found.")
        if time.time() > row.expires_at:
            await session.delete(row)
            await session.commit()
            raise RunNotFound(f"Run {run_id} expired.")
        history = await _loadHistory(session, run_id)
        run = _compose(row, history)
        result = fn(run)
        row.state = _stateOf(run).model_dump(mode="json")
        row.notes = run.notes
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
        result = await session.exec(delete(SimulationRun).where(SimulationRun.expires_at < time.time()))
        await session.commit()
        return result.rowcount


# Background loop that periodically purges expired runs.
async def cleanupRuns(interval: int = RUN_CLEANUP_INTERVAL) -> None:
    while True:
        await asyncio.sleep(interval)
        try: await deleteRuns()
        except Exception: pass
