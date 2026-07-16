import asyncio
import json
import time
from infra.db import getDb, rowToDict
from infra.pubsub import publish_run_update
from infra.settings import MAX_SIMULATION_DURATION


class SimulationRunError(Exception):
    """Base for domain errors raised by RunStore."""


class RunNotFound(SimulationRunError):
    """No run exists for this id."""


class RunExpired(SimulationRunError):
    """The run was purged just now."""


class RunWriteConflict(SimulationRunError):
    """mutate() exhausted its retries racing concurrent writers for this run."""


RUN_TTL_GRACE_MINUTES = 15
# Same cap CasePayload.simulation_duration validates against (models/cases.py) — kept as
# one shared constant so a run's stored TTL can never fall short of the duration a case
# was actually allowed to declare.
MAX_RUN_LIFETIME = MAX_SIMULATION_DURATION
CLEANUP_INTERVAL = 300  # how often the background sweeper runs


# Absolute unix time at which this run should be deleted.
def compute_expiry(run: dict) -> float:
    duration = (run.get("case_snapshot") or {}).get("simulation_duration")
    cap_seconds = MAX_RUN_LIFETIME * 60
    if duration: ttl_seconds = min((duration + RUN_TTL_GRACE_MINUTES) * 60, cap_seconds)
    else: ttl_seconds = cap_seconds
    return run["start_time"] + ttl_seconds


# Run dict -> JSON string for the ``data`` column. ``unlocked_referred_ids`` is a set (not JSON-native), so it's stored
# as a sorted list and rebuilt as a set on load
def serialize_run(run: dict) -> str:
    """"""
    to_store = dict(run)
    to_store["unlocked_referred_ids"] = sorted(run.get("unlocked_referred_ids") or ())
    return json.dumps(to_store)


# Inverse
def deserialize_run(data: str) -> dict:
    run = json.loads(data)
    run["unlocked_referred_ids"] = set(run.get("unlocked_referred_ids") or ())
    return run



class RunStore:
    # Insert a freshly-built run under ``run_id``
    async def put(self, run_id: str, run: dict) -> None:
        client = getDb()
        await client.execute(
            "insert into simulation_runs (run_id, expires_at, data, version) "
            "values (?, ?, ?, 0)",
            (run_id, compute_expiry(run), serialize_run(run)),
        )


    # Return (run dict, version)
    async def get_row(self, run_id: str) -> tuple[dict, int]:
        client = getDb()
        result = await client.execute(
            "select data, expires_at, version from simulation_runs where run_id = ?",
            (run_id,),
        )
        if not result.rows: raise RunNotFound(run_id)
        row = rowToDict(result.rows[0])
        if time.time() > row["expires_at"]:
            await client.execute("delete from simulation_runs where run_id = ?", (run_id,))
            raise RunExpired(run_id)
        return deserialize_run(row["data"]), row["version"]


    # Return the run
    async def get(self, run_id: str) -> dict:
        run, _version = await self.get_row(run_id)
        return run


    # Load the run, apply ``fn``, persist it under an optimistic-lock check, and return ``fn``'s result.
    # ``fn`` receives the deserialized run dict and mutates it in place; its return value is handed back to the caller.
    async def mutate(self, run_id: str, fn, *, max_retries: int = 5):
        client = getDb()
        for attempt in range(max_retries):
            run, version = await self.get_row(run_id)  # also enforces not-found / expired
            result = fn(run)
            update_result = await client.execute(
                "update simulation_runs set data = ?, version = version + 1 "
                "where run_id = ? and version = ?",
                (serialize_run(run), run_id, version),
            )
            if update_result.rows_affected:
                await publish_run_update(run_id)
                return result
        raise RunWriteConflict(run_id)


    # Delete every run past its ``expires_at``
    async def purge_expired(self) -> int:
        client = getDb()
        result = await client.execute(
            "delete from simulation_runs where expires_at < ?", (time.time(),)
        )
        return result.rows_affected


run_store = RunStore()


# Background loop that periodically purges expired runs.
async def cleanup_expired_runs(interval: int = CLEANUP_INTERVAL) -> None:
    while True:
        await asyncio.sleep(interval)
        try: await run_store.purge_expired()
        except Exception: pass
