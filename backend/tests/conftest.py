
import os

os.environ.setdefault("SPACES_KEY", "test-key")
os.environ.setdefault("SPACES_SECRET", "test-secret")
os.environ.setdefault("SPACES_BUCKET", "test-bucket")
os.environ.setdefault("DB_URL", "libsql://test.invalid")
os.environ.setdefault("DB_TOKEN", "test-token")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault("JWT_SECRET", "x" * 32)
os.environ.setdefault("LLM_KEY", "test-llm-key")

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

import api.admin as admin_api_module
import infra.db as db_module
import infra.rate_limit as rate_limit_module
import services.simulation.run_store as run_store_module
import services.simulation.service as service_module
from infra.db import asyncpgUrl
from infra.settings import get_settings

# Every module that imports `get_session` directly (plain data-access functions take
# a session as a parameter instead, so they don't need patching here). db_module
# covers everything routed through the getRequestSession FastAPI dependency
# (api.dependencies, api.cases, and admin.py's admin-management routes all call
# it rather than importing get_session themselves) — patching it here is enough
# since getRequestSession's own `get_session()` call resolves against infra.db's
# (now-patched) module globals at call time. admin_api_module still needs its own
# patch for the login route, which calls get_session directly (no other
# dependency needs a session there, so there's nothing to share it with).
SESSION_OWNING_MODULES = (
    service_module,
    run_store_module,
    rate_limit_module,
    admin_api_module,
    db_module,
)


@pytest_asyncio.fixture
async def db_session(monkeypatch):
    settings = get_settings()
    if not settings.pooling_url:
        pytest.skip("POOLING not set in backend/.env - skipping Postgres-backed test.")

    engine = create_async_engine(
        asyncpgUrl(settings.pooling_url),
        connect_args={"ssl": True, "statement_cache_size": 0},
    )
    async with engine.connect() as conn:
        await conn.begin()

        def get_session():
            return AsyncSession(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)

        for module in SESSION_OWNING_MODULES:
            monkeypatch.setattr(module, "get_session", get_session)

        yield conn
        await conn.rollback()
    await engine.dispose()
