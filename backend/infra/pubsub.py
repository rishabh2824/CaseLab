from contextlib import asynccontextmanager
from functools import lru_cache
import redis.asyncio as redis
from infra.settings import get_settings

RUN_CHANNEL_PREFIX = "run:"


@lru_cache(maxsize=1)
def _client() -> redis.Redis | None:
    url = get_settings().redis_url
    if not url: return None
    return redis.from_url(url)


# Best-effort: a run's live WebSocket viewers also poll on their own (see
# STATE_POLL_INTERVAL_SECONDS in api/simulations.py), so a missed or failed
# publish just means that viewer waits for the next poll tick instead of
# refreshing instantly — never a correctness issue, only a latency one.
async def publish_run_update(run_id: str) -> None:
    client = _client()
    if client is None: return
    try:
        await client.publish(f"{RUN_CHANNEL_PREFIX}{run_id}", "1")
    except Exception:
        pass


# Yields an object with a `get(timeout)` coroutine returning True if a
# publish arrived within `timeout` seconds, False on timeout — or None
# itself if Redis isn't configured, meaning the caller should just poll.
@asynccontextmanager
async def subscribe_run_updates(run_id: str):
    client = _client()
    if client is None:
        yield None
        return
    pubsub = client.pubsub()
    await pubsub.subscribe(f"{RUN_CHANNEL_PREFIX}{run_id}")
    try:
        yield pubsub
    finally:
        await pubsub.unsubscribe(f"{RUN_CHANNEL_PREFIX}{run_id}")
        await pubsub.aclose()
