from functools import lru_cache
from collections.abc import AsyncIterator
from urllib.parse import urlsplit, urlunsplit
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession
from infra.settings import get_settings


# Converts the connection URLs given by Neon to ones that asyncpg (PostGre SQL driver) can understand
def asyncpgUrl(url: str) -> str:
    if url.startswith("postgresql://"): url = "postgresql+asyncpg://" + url[len("postgresql://") :]
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", parts.fragment))


LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", ""}


# Every managed Postgres (Neon included) requires TLS, and asyncpg fails the
# connection outright rather than downgrading — so ssl stays on by default. A
# loopback database is the CI service container or a local dev instance, which
# serves no certificate at all; asking for TLS there fails before the first
# query. Host-based rather than a flag, so no environment can accidentally
# turn TLS off against a real remote database.
def requiresSsl(url: str) -> bool:
    return (urlsplit(url).hostname or "") not in LOOPBACK_HOSTS


# @lru_cache(maxsize=1) ensures only a single engine is created.
@lru_cache(maxsize=1)
def getEngine() -> AsyncEngine:
    settings = get_settings()

    # Doesn't immediately connect to the db, does it lazily when first needed.
    return create_async_engine(
        # "ssl" - Forces a secure, encrypted connection to Neon
        # statement_cache_size=0 - turns off asyncpg's internal caching of SQL queries to avoid weird crashes
        # pool_pre_ping=True - Ensures the db is alive before handing over a connection to a request
        asyncpgUrl(settings.pooling_url),
        connect_args={"ssl": requiresSsl(settings.pooling_url), "statement_cache_size": 0},
        pool_pre_ping=True,
    )


# Creates a factory to pump out sessions for a request. Each request gets a separate session
@lru_cache(maxsize=1)
def getSessionFactory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(getEngine(), class_=AsyncSession, expire_on_commit=False)


def get_session() -> AsyncSession:
    return getSessionFactory()()


# FastAPI dependency: one session per request, shared across every Depends() that
# asks for it (FastAPI caches a dependency's result per request), instead of each
# auth check and each endpoint handler opening its own separate connection.
async def getRequestSession() -> AsyncIterator[AsyncSession]:
    async with get_session() as session:
        yield session


async def closeDb() -> None:
    if getEngine.cache_info().currsize > 0:
        await getEngine().dispose()
        getEngine.cache_clear()
        getSessionFactory.cache_clear()


# Basically the engine lazily creates a connection when needed, and the sessions use these connections to fulfill
# requests. One session needs one connection, but the connection can be reused once a session is over.
