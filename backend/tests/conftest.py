"""Root fixtures.

Layout: `tests/unit/` must never touch the network or a database — those tests
patch the DB/LLM/Spaces seams and run in milliseconds. `tests/integration/`
talks to a real Postgres and is auto-marked `db`, so the fast suite is::

    uv run pytest -m "not db"

and CI runs everything against a throwaway Postgres service container.
"""

from __future__ import annotations

import uuid
from urllib.parse import urlsplit

import pytest
from infra.db import get_session
from infra.db_models import Admin, Case
from infra.settings import get_settings
from models.admin import AdminRole


def pytest_collection_modifyitems(config, items):
    """Auto-mark everything under tests/integration/ as `db` so no one has to
    remember the decorator (and so an unmarked DB test can't sneak into the
    fast suite)."""
    for item in items:
        if "integration" in item.nodeid.split("/"):
            item.add_marker(pytest.mark.db)


def pytest_report_header(config):
    """Print which database the DB-backed tests will hit. These tests create
    and delete real rows, so 'which host' is not a detail worth guessing at —
    point POOLING at a throwaway database, not the production one."""
    try:
        host = urlsplit(get_settings().pooling_url).hostname or "unset"
    except Exception as exc:  # settings are incomplete — unit tests may still run
        return f"database: unavailable ({type(exc).__name__})"
    return f"database: {host}"


def uniqueEmail(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}@test.caselab.invalid"


@pytest.fixture
async def session():
    async with get_session() as s:
        yield s


class Cleanup:
    """Tracks rows created during a test so they can be torn down afterward,
    regardless of what the test itself did to them (promoted, deleted, etc.).
    Cases are deleted before admins to respect cases.admin's FK. Uses its own
    fresh session in teardown so it's unaffected by anything the test did to
    the `session` fixture (e.g. monkeypatching commit)."""

    def __init__(self, session):
        self._session = session
        self.case_ids: list[int] = []
        self.admin_ids: list[int] = []

    async def make_admin(self, role: AdminRole = AdminRole.ADMIN) -> Admin:
        admin = Admin(email=uniqueEmail(AdminRole(role).name.lower()), role=int(role))
        self._session.add(admin)
        await self._session.commit()
        await self._session.refresh(admin)
        self.admin_ids.append(admin.id)
        return admin

    def track_case(self, case_id: int) -> None:
        self.case_ids.append(case_id)

    def track_admin(self, admin_id: int) -> None:
        self.admin_ids.append(admin_id)


@pytest.fixture
async def cleanup(session):
    registry = Cleanup(session)
    yield registry

    async with get_session() as teardown_session:
        for case_id in registry.case_ids:
            case = await teardown_session.get(Case, case_id)
            if case is not None:
                await teardown_session.delete(case)
        await teardown_session.commit()

        for admin_id in registry.admin_ids:
            admin = await teardown_session.get(Admin, admin_id)
            if admin is not None:
                await teardown_session.delete(admin)
        await teardown_session.commit()
