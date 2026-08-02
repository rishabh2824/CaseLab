import asyncio
import time
from copy import deepcopy
from sqlalchemy import delete
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import select
from domain_errors import RunNotFound
from infra.db import get_session
from infra.db_models import SimulationRun
from infra.settings import SIMULATION_DURATION


GRACE_PERIOD = 15 # Grace Period for students to save notes / chat after simulation duration is over.
RUN_LIFETIME = SIMULATION_DURATION
RUN_CLEANUP_INTERVAL = 86400  # how often the background sweeper runs


# Absolute unix time at which this run should be deleted.
def expiry(run: dict) -> float:
    duration = (run.get("case_snapshot") or {}).get("simulation_duration")
    cap_seconds = RUN_LIFETIME * 60
    if duration: ttl_seconds = min((duration + GRACE_PERIOD) * 60, cap_seconds)
    else: ttl_seconds = cap_seconds
    return run["start_time"] + ttl_seconds


# Run dict -> JSONB-ready dict
def serializeRun(run: dict) -> dict:
    to_store = dict(run)
    to_store["unlocked_referred_ids"] = sorted(run.get("unlocked_referred_ids") or ())
    return to_store


# Inverse
def deserializeRun(data: dict) -> dict:
    run = deepcopy(data)
    run["unlocked_referred_ids"] = set(run.get("unlocked_referred_ids") or ())
    return run


# Insert a freshly-built run under ``run_id``
async def insertRun(run_id: str, run: dict) -> None:
    async with get_session() as session:
        session.add(SimulationRun(run_id=run_id, expires_at=expiry(run), data=serializeRun(run)))
        await session.commit()


async def getRun(run_id: str) -> dict:
    async with get_session() as session:
        row = await session.get(SimulationRun, run_id)
        if row is None: raise RunNotFound(f"Run {run_id} not found.")
        if time.time() > row.expires_at:
            await session.delete(row)
            await session.commit()
            raise RunNotFound(f"Run {run_id} expired.")
        return deserializeRun(row.data)


async def updateRun(run_id: str, fn):
    async with get_session() as session:
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
        run = deserializeRun(row.data)
        result = fn(run)
        row.data = serializeRun(run)
        flag_modified(row, "data")
        session.add(row)
        await session.commit()
    return result


# Delete every run past its ``expires_at``
async def deleteRuns() -> int:
    async with get_session() as session:
        result = await session.exec(delete(SimulationRun).where(SimulationRun.expires_at < time.time()))
        await session.commit()
        return result.rowcount


# Background loop that periodically purges expired runs.
async def cleanupRuns(interval: int = RUN_CLEANUP_INTERVAL) -> None:
    while True:
        await asyncio.sleep(interval)
        try: await deleteRuns()
        except Exception: pass
