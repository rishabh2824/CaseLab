"""DB-backed tests for infra/rate_limit.py + services/rate_limits.py.

The fixed-window limiter is a single Postgres `INSERT ... ON CONFLICT DO
UPDATE ... RETURNING` statement — its correctness (pinned start_time within a
window, reset once the window elapses, and no lost updates under concurrent
callers) lives entirely in that one SQL statement, so mocking the DB away
would test nothing.
"""

import asyncio
import time
import uuid

import pytest
from sqlalchemy import delete
import infra.rate_limit as rate_limit
from domain_errors import RateLimited
from infra.db import getSession
from infra.db_models import RateLimit
from services import rate_limits as repo


# upsertAndGet needs the RETURNING clause from a Core INSERT ... ON CONFLICT
# statement, which session.exec() doesn't support — same reason
# pyproject.toml's filterwarnings already exempts services.cases and
# services.admin from "session.execute() is deprecated, use exec()". This
# file is the first to exercise services.rate_limits directly, so it needs
# the same exemption; added here rather than in pyproject.toml (off-limits
# per the task rules) since pytest.mark.filterwarnings can scope it per-file
# just as well.
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning:services.rate_limits")


def uniqueKey(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


@pytest.fixture
async def rateLimitKeys():
    """Tracks every rate_limits.key this test created so it can be swept up
    afterward — this table is shared with the running application, so a
    leaked row would sit there polluting real rate-limit counts."""
    keys: list[str] = []
    yield keys
    async with getSession() as session:
        await session.exec(delete(RateLimit).where(RateLimit.key.in_(keys)))
        await session.commit()


async def test_first_call_creates_row_then_repeated_calls_increment_with_pinned_start_time(rateLimitKeys):
    key = uniqueKey("upsert")
    rateLimitKeys.append(key)

    async with getSession() as session:
        first = await repo.upsertAndGet(session, key, now=1_700_000_000.0, window_seconds=60)
    assert first == {"count": 1, "start_time": 1_700_000_000.0}

    # Still inside the window — count increments but start_time stays pinned
    # to the very first call, which is what makes "time left in this window"
    # computable at all.
    async with getSession() as session:
        second = await repo.upsertAndGet(session, key, now=1_700_000_010.0, window_seconds=60)
    assert second == {"count": 2, "start_time": 1_700_000_000.0}

    async with getSession() as session:
        third = await repo.upsertAndGet(session, key, now=1_700_000_059.0, window_seconds=60)
    assert third == {"count": 3, "start_time": 1_700_000_000.0}


async def test_window_elapsed_resets_count_and_advances_start_time(rateLimitKeys):
    key = uniqueKey("reset")
    rateLimitKeys.append(key)

    async with getSession() as session:
        await repo.upsertAndGet(session, key, now=1_700_000_000.0, window_seconds=60)

    # `now` far enough past start_time + window_seconds that the window has
    # definitely elapsed — driven directly rather than via time.sleep(60).
    async with getSession() as session:
        row = await repo.upsertAndGet(session, key, now=1_700_000_500.0, window_seconds=60)
    assert row == {"count": 1, "start_time": 1_700_000_500.0}


async def test_message_limit_raises_rate_limited_with_positive_retry_after(monkeypatch, rateLimitKeys):
    run_id = uniqueKey("run")
    rateLimitKeys.append(f"message:{run_id}")
    # Drive MESSAGE_LIMIT down so the test doesn't need 16 real round trips
    # against Neon to trip it.
    monkeypatch.setattr(rate_limit, "MESSAGE_LIMIT", 2)

    await rate_limit.messageLimit(run_id)
    await rate_limit.messageLimit(run_id)
    with pytest.raises(RateLimited) as exc_info:
        await rate_limit.messageLimit(run_id)

    retry_after = int(exc_info.value.headers["Retry-After"])
    assert retry_after > 0


async def test_simulation_limit_normalizes_whitespace_and_case_into_one_bucket(rateLimitKeys):
    code = uniqueKey("code").upper()
    key = f"start:{code}"
    rateLimitKeys.append(key)

    # "  abc " and "ABC" (mixed whitespace/casing of the same code) must land
    # in the same bucket — simulationLimit trims + upper-cases before keying.
    await rate_limit.simulationLimit(f"  {code.lower()} ")
    await rate_limit.simulationLimit(code)

    async with getSession() as session:
        row = await session.get(RateLimit, key)
    assert row is not None
    assert row.count == 2


async def test_upsert_and_get_is_race_free_under_concurrency(rateLimitKeys):
    # The whole reason upsertAndGet is one atomic INSERT ... ON CONFLICT
    # statement (instead of a SELECT-then-UPDATE) is to survive concurrent
    # callers without losing updates. Fire N genuinely concurrent calls, each
    # on its own session/connection, and the final count must be exactly N.
    key = uniqueKey("concurrent")
    rateLimitKeys.append(key)
    n = 20
    now = time.time()

    async def bump():
        async with getSession() as session:
            return await repo.upsertAndGet(session, key, now, window_seconds=60)

    await asyncio.gather(*[bump() for _ in range(n)])

    async with getSession() as session:
        row = await session.get(RateLimit, key)
    assert row.count == n


async def test_purge_stale_limits_deletes_only_rows_past_the_window(rateLimitKeys):
    fresh_key = uniqueKey("fresh")
    stale_key = uniqueKey("stale")
    rateLimitKeys.extend([fresh_key, stale_key])
    now = time.time()

    async with getSession() as session:
        await repo.upsertAndGet(session, fresh_key, now, window_seconds=60)
        # A window that started two minutes ago is well past purgeStaleLimits'
        # 60-second cutoff.
        await repo.upsertAndGet(session, stale_key, now - 120, window_seconds=60)

    await rate_limit.purgeStaleLimits()

    # purgeStaleLimits sweeps the whole shared table (other concurrent tests
    # or the live app may also have stale rows), so assert on our two keys
    # individually rather than the aggregate deleted count.
    async with getSession() as session:
        assert await session.get(RateLimit, stale_key) is None
        assert await session.get(RateLimit, fresh_key) is not None
