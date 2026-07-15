"""Shared test setup.

Dummy env vars are set at import time — before any `infra.settings.Settings`
instance is constructed — so the suite never depends on the real `.env` secrets
(and runs identically in CI where no `.env` exists). Nothing here calls the network:
tests that exercise DB-backed code use the in-memory `FakeClient` below.
"""

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


class FakeResult:
    def __init__(self, rows, rows_affected=0):
        self.rows = rows
        self.rows_affected = rows_affected


class FakeRow(dict):
    """A libsql row exposes columns as attributes AND `.asdict()`; the code under
    test only uses `.asdict()`, so a dict subclass with that method suffices."""

    def asdict(self):
        return dict(self)


@pytest.fixture
def fake_client():
    """A minimal stand-in for the libsql async client backed by a single
    in-memory `simulation_runs`-style table keyed by run_id. Only implements the
    exact SQL shapes RunStore issues — insert, select-by-id, versioned update,
    and delete — matched by substring so the tests stay coupled to behavior, not
    to exact whitespace."""

    class FakeClient:
        def __init__(self):
            # run_id -> {"data": str, "expires_at": float, "version": int}
            self.rows = {}
            self.executed = []

        async def execute(self, sql, params=()):
            self.executed.append((sql, params))
            s = " ".join(sql.split()).lower()

            if s.startswith("insert into simulation_runs"):
                run_id, expires_at, data = params
                self.rows[run_id] = {
                    "data": data,
                    "expires_at": expires_at,
                    "version": 0,
                }
                return FakeResult([], rows_affected=1)

            if s.startswith("select data, expires_at, version from simulation_runs"):
                (run_id,) = params
                row = self.rows.get(run_id)
                if row is None:
                    return FakeResult([])
                return FakeResult([FakeRow(run_id=run_id, **row)])

            if s.startswith("update simulation_runs set data"):
                data, run_id, expected_version = params
                row = self.rows.get(run_id)
                if row is None or row["version"] != expected_version:
                    return FakeResult([], rows_affected=0)
                row["data"] = data
                row["version"] += 1
                return FakeResult([], rows_affected=1)

            if s.startswith("delete from simulation_runs where run_id"):
                (run_id,) = params
                existed = self.rows.pop(run_id, None) is not None
                return FakeResult([], rows_affected=1 if existed else 0)

            if s.startswith("delete from simulation_runs where expires_at"):
                (cutoff,) = params
                stale = [k for k, v in self.rows.items() if v["expires_at"] < cutoff]
                for k in stale:
                    del self.rows[k]
                return FakeResult([], rows_affected=len(stale))

            raise AssertionError(f"Unexpected SQL in FakeClient: {sql!r}")

        async def close(self):
            pass

    return FakeClient()
