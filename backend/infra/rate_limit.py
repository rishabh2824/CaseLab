import asyncio
import time
from math import ceil
from fastapi import HTTPException
from Queries import rate_limits as repo
from infra.db import getDb


MESSAGE_LIMIT = 15 # Number of messages a single student can send in one minute
START_LIMIT = 200 # How many runs can exist at a time
CLEANUP_INTERVAL = 300  # how often the stale-row sweeper runs


async def messageLimit(run_id: str) -> None:
    client = getDb()
    key = f"message:{run_id}"
    now = time.time()
    row = await repo.upsert_and_get(client, key, now, 60)

    if row["count"] > MESSAGE_LIMIT:
        retry_after = max(1, ceil(row["window_start"] + 60 - now))
        raise HTTPException(status_code=429, detail="Rate Limit exceeded", headers={"Retry-After": str(retry_after)})


async def simulationLimit(access_code: str) -> None:
    client = getDb()
    key = f"start:{access_code.strip().upper()}"
    now = time.time()
    row = await repo.upsert_and_get(client, key, now, 60)
    if row["count"] > START_LIMIT:
        retry_after = max(
            1, ceil(row["window_start"] + 60 - now)
        )
        raise HTTPException(
            status_code=429,
            detail="Too many simulations have been started with this access code recently. Please wait a moment and try again.",
            headers={"Retry-After": str(retry_after)},
        )


# Deletes all rate-limit rows in the rate_limits table whose window started more than 60 seconds ago
async def purgeStaleLimits() -> int:
    client = getDb()
    cutoff = time.time() - 60
    return await repo.delete_stale(client, cutoff)


# Calls the above method
async def cleanStaleLimits(interval: int = CLEANUP_INTERVAL) -> None:
    while True:
        await asyncio.sleep(interval)
        try: await purgeStaleLimits()
        except Exception: pass
