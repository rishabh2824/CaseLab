#Data access for the fixed-window rate_limits table.

from infra.db import rowToDict


async def upsert_and_get(client, key: str, now: float, window_seconds: int) -> dict:
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
            window_seconds,
            now,
            window_seconds,
            now,
        ),
    )
    result = await client.execute(
        "select count, window_start from rate_limits where key = ?", (key,)
    )
    return rowToDict(result.rows[0])


async def delete_stale(client, cutoff: float) -> int:
    result = await client.execute(
        "delete from rate_limits where window_start < ?", (cutoff,)
    )
    return result.rows_affected
