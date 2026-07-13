"""Fixed-window request rate limiting, backed by the ``rate_limits`` table.

Currently used for exactly one thing: capping how fast a single simulation
run can hit ``POST /simulations/{run_id}/message`` (see
services.simulation.service.prepare_message), independent of the frontend's
``isSending`` guard, which only prevents concurrent sends from the same
browser tab — not a script hitting the endpoint directly. Keyed by a
caller-defined string (``"message:<run_id>"`` today) so the same table can
host other limiter types later without a schema change.
"""

import asyncio
import logging
import time
from math import ceil

from fastapi import HTTPException

from services.db import get_db_client, row_to_dict

logger = logging.getLogger("caselab.rate_limit")

# A real turn already takes several seconds end-to-end (safety classifier +
# referral/file judges + the frontier reply model), and the frontend's
# isSending guard means a browser can never have more than one in-flight
# /message call per run — so normal UI usage never gets close to this. It
# only binds direct API/script traffic. Adjust here if it's too tight/loose
# in practice.
MESSAGE_RATE_LIMIT_MAX = 12
MESSAGE_RATE_LIMIT_WINDOW_SECONDS = 60
CLEANUP_INTERVAL_SECONDS = 5 * 60  # how often the stale-row sweeper runs


async def enforce_message_rate_limit(run_id: str) -> None:
    """Record this request against ``run_id``'s window and raise
    HTTPException(429) if that pushes it over MESSAGE_RATE_LIMIT_MAX.

    The INSERT..ON CONFLICT DO UPDATE unconditionally records the request
    (increment within the current window, or reset to 1 if the window has
    fully elapsed) in one atomic statement — race-free by construction, so
    two concurrent requests for the same run_id can't both read a pre-write
    count and both slip through. The follow-up SELECT (to decide allow/reject)
    is a separate round trip, so a concurrent script could rarely read a count
    bumped by another concurrent request and reject itself a touch early —
    an over-rejection, never a bypass, and only reachable by non-browser
    traffic; accepted as harmless for a cost-control limiter.

    Rejected requests still count against the window (it doesn't extend on a
    hit, only resets once fully elapsed), so retrying after a 429 doesn't
    grant a fresh window.
    """
    client = get_db_client()
    key = f"message:{run_id}"
    now = time.time()
    await client.execute(
        """
        insert into rate_limits (key, window_start, count) values (?, ?, 1)
        on conflict(key) do update set
          count = case when ? - window_start >= ? then 1 else count + 1 end,
          window_start = case when ? - window_start >= ? then ? else window_start end
        """,
        (
            key,
            now,
            now,
            MESSAGE_RATE_LIMIT_WINDOW_SECONDS,
            now,
            MESSAGE_RATE_LIMIT_WINDOW_SECONDS,
            now,
        ),
    )
    result = await client.execute(
        "select count, window_start from rate_limits where key = ?", (key,)
    )
    row = row_to_dict(result.rows[0])
    if row["count"] > MESSAGE_RATE_LIMIT_MAX:
        retry_after = max(
            1, ceil(row["window_start"] + MESSAGE_RATE_LIMIT_WINDOW_SECONDS - now)
        )
        raise HTTPException(
            status_code=429,
            detail="You're sending messages too quickly. Please wait a moment and try again.",
            headers={"Retry-After": str(retry_after)},
        )


async def purge_stale_rate_limits() -> int:
    """Delete rate-limit rows whose window has fully elapsed. Returns the
    count removed.

    Once a key's window is more than MESSAGE_RATE_LIMIT_WINDOW_SECONDS behind
    now, the row is dead weight — the next request for that key resets it
    from scratch anyway (see enforce_message_rate_limit's ON CONFLICT branch).
    """
    client = get_db_client()
    cutoff = time.time() - MESSAGE_RATE_LIMIT_WINDOW_SECONDS
    result = await client.execute(
        "delete from rate_limits where window_start < ?", (cutoff,)
    )
    count = result.rows_affected
    if count:
        logger.info("Purged %d stale rate-limit row(s)", count)
    return count


async def cleanup_stale_rate_limits_forever(interval: int = CLEANUP_INTERVAL_SECONDS) -> None:
    """Background loop that periodically purges stale rate-limit rows.

    Started from the FastAPI lifespan in main.py and cancelled on shutdown,
    alongside (but independent of) services.simulation.state's own sweeper.
    """
    while True:
        await asyncio.sleep(interval)
        try:
            await purge_stale_rate_limits()
        except Exception:
            logger.exception("Error while purging stale rate-limit rows")
