import asyncio
import time
from math import ceil
from fastapi import HTTPException
from services import rate_limits as repo
from infra.db import get_session


MESSAGE_LIMIT = 15 # Number of messages a single student can send in one minute
START_LIMIT = 200 # How many runs can exist at a time
CLEANUP_INTERVAL = 300  # how often the stale-row sweeper runs


async def messageLimit(run_id: str) -> None:
    key = f"message:{run_id}"
    now = time.time()
    async with get_session() as session:
        row = await repo.upsertAndGet(session, key, now, 60)

    if row["count"] > MESSAGE_LIMIT:
        retry_after = max(1, ceil(row["start_time"] + 60 - now))
        raise HTTPException(status_code=429, detail="Rate Limit exceeded", headers={"Retry-After": str(retry_after)})


async def simulationLimit(access_code: str) -> None:
    key = f"start:{access_code.strip().upper()}"
    now = time.time()
    async with get_session() as session:
        row = await repo.upsertAndGet(session, key, now, 60)
    if row["count"] > START_LIMIT:
        retry_after = max(
            1, ceil(row["start_time"] + 60 - now)
        )
        raise HTTPException(
            status_code=429,
            detail="Too many simulations have been started with this access code recently. Please wait a moment and try again.",
            headers={"Retry-After": str(retry_after)},
        )


# Deletes all rate-limit rows in the rate_limits table whose window started more than 60 seconds ago
async def purgeStaleLimits() -> int:
    cutoff = time.time() - 60
    async with get_session() as session:
        return await repo.deleteStale(session, cutoff)


# Calls the above method
async def cleanStaleLimits(interval: int = CLEANUP_INTERVAL) -> None:
    while True:
        await asyncio.sleep(interval)
        try: await purgeStaleLimits()
        except Exception: pass
