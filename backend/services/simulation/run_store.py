import asyncio
import time
from collections.abc import Callable
from sqlalchemy import delete
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import select
from domain_errors import RunNotFound
from infra.db import getSession
from infra.db_models import SimulationRun
from domain_constants import SIMULATION_DURATION
from models.simulation_runtime import Run


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


# Insert a freshly-built run under ``run_id``
async def insertRun(run_id: str, run: Run) -> None:
    async with getSession() as session:
        session.add(SimulationRun(run_id=run_id, expires_at=expiry(run), data=run.model_dump(mode="json")))
        await session.commit()


async def getRun(run_id: str) -> Run:
    async with getSession() as session:
        row = await session.get(SimulationRun, run_id)
        if row is None: raise RunNotFound(f"Run {run_id} not found.")
        if time.time() > row.expires_at:
            await session.delete(row)
            await session.commit()
            raise RunNotFound(f"Run {run_id} expired.")
        return Run.model_validate(row.data)


# fn mutates the already-validated Run in place (attribute/dict/set mutation) — no
# re-validation happens between the load and save below (Pydantic v2 doesn't intercept
# attribute reassignment or nested-container mutation unless validate_assignment=True,
# which Run doesn't set).
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
        run = Run.model_validate(row.data)
        result = fn(run)
        row.data = run.model_dump(mode="json")
        # row.data is a fresh dict object on every assignment above (never mutated
        # in place), which SQLAlchemy's ordinary attribute-history tracking already
        # detects on its own; flag_modified is a no-op safeguard in case that ever
        # changes to in-place mutation of row.data instead.
        flag_modified(row, "data")
        session.add(row)
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
