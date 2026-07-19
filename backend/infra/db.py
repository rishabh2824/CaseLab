from functools import lru_cache
from urllib.parse import urlsplit, urlunsplit
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession
from infra.settings import get_settings


# Converts the connection URLs given by Neon to ones that asyncpg (PostGre SQL driver) can understand
def asyncpgUrl(url: str) -> str:
    if url.startswith("postgresql://"): url = "postgresql+asyncpg://" + url[len("postgresql://") :]
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", parts.fragment))


# @lru_cache(maxsize=1) ensures only a single engine is created.
@lru_cache(maxsize=1)
def getEngine() -> AsyncEngine:
    settings = get_settings()

    # Doesn't immediately connect to the db, does it lazily when first needed.
    return create_async_engine(
        # "ssl": True - Forces a secure, encrypted connection to Neon
        # statement_cache_size=0 - turns off asyncpg's internal caching of SQL queries to avoid weird crashes
        # pool_pre_ping=True - Ensures the db is alive before handing over a connection to a request
        asyncpgUrl(settings.pooling_url), connect_args={"ssl": True, "statement_cache_size": 0}, pool_pre_ping=True
    )


# Creates a factory to pump out sessions for a request. Each request gets a separate session
@lru_cache(maxsize=1)
def getSessionFactory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(getEngine(), class_=AsyncSession, expire_on_commit=False)


def get_session() -> AsyncSession:
    return getSessionFactory()()


async def closeDb() -> None:
    if getEngine.cache_info().currsize > 0:
        await getEngine().dispose()
        getEngine.cache_clear()
        getSessionFactory.cache_clear()


# Basically the engine lazily creates a connection when needed, and the sessions use these connections to fulfill
# requests. One session needs one connection, but the connection can be reused once a session is over.