# Data access for the fixed-window rate_limits table.

from sqlalchemy import case, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import select
from infra.db_models import RateLimit


async def upsertAndGet(session, key: str, now: float, window_seconds: int) -> dict:
    stmt = pg_insert(RateLimit).values(key=key, start_time=now, count=1)
    stmt = stmt.on_conflict_do_update(
        index_elements=[RateLimit.key],
        set_={
            "count": case((now - RateLimit.start_time >= window_seconds, 1), else_=RateLimit.count + 1),
            "start_time": case(
                (now - RateLimit.start_time >= window_seconds, now), else_=RateLimit.start_time
            ),
        },
    )
    await session.exec(stmt)
    await session.commit()
    row = (await session.exec(select(RateLimit).where(RateLimit.key == key))).first()
    return {"count": row.count, "start_time": row.start_time}


async def deleteStale(session, cutoff: float) -> int:
    result = await session.exec(delete(RateLimit).where(RateLimit.start_time < cutoff))
    await session.commit()
    return result.rowcount
