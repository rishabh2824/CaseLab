"""Shared pytest fixtures for the backend test suite.

Tests run with ``backend/`` as the import root (matching how the app itself is
launched — see backend/README.md), enabled via the ``pythonpath = ["."]``
pytest.ini option in pyproject.toml rather than any ``sys.path`` hacking here.
"""

import pytest

from settings import get_settings


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    """``get_settings()`` is a process-wide ``lru_cache``d singleton; without
    clearing it around every test, whichever test runs first would freeze env
    vars (via ``monkeypatch.setenv``) for every test that runs after it."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def admin_env(monkeypatch):
    """A consistent set of admin-auth env vars, matching the plan's schema:
    GOOGLE_CLIENT_ID, ADMIN_ALLOWED_DOMAIN, ADMIN_JWT_SECRET."""
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com")
    monkeypatch.setenv("ADMIN_ALLOWED_DOMAIN", "wisc.edu")
    monkeypatch.setenv("ADMIN_JWT_SECRET", "test-secret-key-not-for-prod")
    get_settings.cache_clear()
    return get_settings()


def async_return(fn):
    """Wrap a plain sync callable so it can stand in for an ``async def``
    repository/service function in a monkeypatch — e.g.
    ``monkeypatch.setattr(repo, "get_by_email", async_return(lambda c, e: row))``.
    """

    async def _inner(*args, **kwargs):
        return fn(*args, **kwargs)

    return _inner


@pytest.fixture
def fake_db_client():
    """A sentinel standing in for a real libsql client. Tests that use this
    also monkeypatch every repository call that would otherwise use it, so it
    is never actually queried — it only needs to be a distinct, truthy object
    that flows through unchanged."""
    return object()


@pytest.fixture
def patched_db_client(monkeypatch, fake_db_client):
    """Patch every module-local ``get_db_client`` reference used by the admin
    API/dependency layer, so hitting the real Turso client (which requires
    DB_URL/DB_TOKEN) is never attempted in tests. Each importer bound its own
    name at import time (``from services.db import get_db_client``), so the
    real module (``services.db.get_db_client``) has to be patched per
    importer, not once at the source.
    """
    monkeypatch.setattr("api.admin.get_db_client", lambda: fake_db_client)
    monkeypatch.setattr("api.dependencies.get_db_client", lambda: fake_db_client)
    return fake_db_client
