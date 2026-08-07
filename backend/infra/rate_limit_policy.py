import asyncio
import time
from math import ceil
from domain_errors import RateLimited
from infra import rate_limit_repo as repo
from infra.db import getSession


MESSAGE_LIMIT = 15 # Number of messages a single student can send in one minute
START_LIMIT = 200 # How many runs can exist at a time
CLEANUP_INTERVAL = 300  # how often the stale-row sweeper runs


# `session`, when given, is used directly instead of opening a fresh one — lets a caller
# (turn.py's prepareTurn) fold this write into a larger transaction it already holds open.
# repo.upsertAndGet commits on its own regardless, so the rate-limit count is always
# charged as soon as this returns, even if a later step in the caller's flow fails.
async def messageLimit(run_id: str, *, session=None) -> None:
    key = f"message:{run_id}"
    now = time.time()
    if session is not None:
        row = await repo.upsertAndGet(session, key, now, 60)
    else:
        async with getSession() as session:
            row = await repo.upsertAndGet(session, key, now, 60)

    if row["count"] > MESSAGE_LIMIT:
        retry_after = max(1, ceil(row["start_time"] + 60 - now))
        raise RateLimited("Rate Limit exceeded", retry_after)


async def simulationLimit(access_code: str) -> None:
    key = f"start:{access_code.strip().upper()}"
    now = time.time()
    async with getSession() as session:
        row = await repo.upsertAndGet(session, key, now, 60)
    if row["count"] > START_LIMIT:
        retry_after = max(
            1, ceil(row["start_time"] + 60 - now)
        )
        raise RateLimited(
            "Too many simulations have been started with this access code recently. Please wait a moment and try again.",
            retry_after,
        )


# Deletes all rate-limit rows in the rate_limits table whose window started more than 60 seconds ago
async def purgeStaleLimits() -> int:
    cutoff = time.time() - 60
    async with getSession() as session:
        return await repo.deleteStale(session, cutoff)


# Calls the above method
async def cleanStaleLimits(interval: int = CLEANUP_INTERVAL) -> None:
    while True:
        await asyncio.sleep(interval)
        try: await purgeStaleLimits()
        except Exception: pass
