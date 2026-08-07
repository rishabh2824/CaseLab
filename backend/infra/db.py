from functools import lru_cache
from collections.abc import AsyncIterator
from urllib.parse import urlsplit, urlunsplit
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession
from infra.settings import getSettings


# Converts the connection URLs given by Neon to ones that asyncpg (PostGre SQL driver) can understand
def asyncpgUrl(url: str) -> str:
    if url.startswith("postgresql://"): url = "postgresql+asyncpg://" + url[len("postgresql://") :]
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", parts.fragment))


# Detects prod vs dev, and turns off TLS for dev
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", ""}
def requiresSsl(url: str) -> bool:
    return (urlsplit(url).hostname or "") not in LOOPBACK_HOSTS


# @lru_cache(maxsize=1) ensures only a single engine is created.
@lru_cache(maxsize=1)
def getEngine() -> AsyncEngine:
    settings = getSettings()

    # Connects straight to Postgres (settings.direct_url), not through Neon's pgbouncer-based
    # pooled endpoint -- SQLAlchemy already runs its own pool below, so pgbouncer underneath it
    # was a second, redundant pooling layer. That layering was also *why* statement caching had
    # to be disabled: asyncpg's prepared-statement cache doesn't work safely against pgbouncer's
    # transaction-pooling mode, since a connection's backend can change between statements. Going
    # direct removes that constraint, so asyncpg's statement cache (its default) stays on and
    # Postgres stops re-parsing/re-planning every query on every execution.
    #
    # Doesn't immediately connect to the db, does it lazily when first needed.
    return create_async_engine(
        # "ssl" - Forces a secure, encrypted connection to Neon
        asyncpgUrl(settings.direct_url),
        connect_args={"ssl": requiresSsl(settings.direct_url)},
        # Neon (like most managed Postgres) silently drops idle connections after a timeout.
        # pool_recycle proactively retires a pooled connection once it's been open this long,
        # so a request never lands on one the server already closed -- without paying pre_ping's
        # per-checkout round trip to check liveness on every single request.
        pool_recycle=300,
        # SQLAlchemy's defaults (pool_size=5, max_overflow=10 -> 15 connections/worker,
        # pool_timeout=30) were never a deliberate choice for this app's load. A classroom
        # of ~60 students submitting near-simultaneously, each holding a handful of
        # concurrent checkouts over the course of a request, can plausibly want way more
        # than 15 connections at once from a single worker -- past that, checkouts queue
        # silently and then hard-fail with a pool-timeout error instead of degrading
        # gracefully. Sized to comfortably cover that burst. NOTE: this used to be sized
        # against Neon's pooled endpoint, which fans out far beyond any single per-worker
        # limit -- now that this connects directly to Postgres, pool_size + max_overflow
        # (40 total, single-instance deployment as of writing) needs to actually fit inside
        # the Neon plan's real max_connections, which a pgbouncer-fronted endpoint never had
        # to respect. Re-check both this and the deployed worker/instance count against
        # whatever connection budget the Postgres plan allows before relying on this number.
        pool_size=20,
        max_overflow=20,
        pool_timeout=30,
    )


# Creates a factory to pump out sessions for a request. Each request gets a separate session
@lru_cache(maxsize=1)
def getSessionFactory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(getEngine(), class_=AsyncSession, expire_on_commit=False)


def getSession() -> AsyncSession:
    return getSessionFactory()()


# FastAPI dependency: one session per request, shared across every Depends() that asks for it, instead of each auth check and
# endpoint handler opening its own separate connection.
async def getRequestSession() -> AsyncIterator[AsyncSession]:
    async with getSession() as session:
        yield session


async def closeDb() -> None:
    if getEngine.cache_info().currsize > 0:
        await getEngine().dispose()
        getEngine.cache_clear()
        getSessionFactory.cache_clear()


# Basically the engine lazily creates a connection when needed, and the sessions use these connections to fulfill
# requests. One session needs one connection, but the connection can be reused once a session is over.
