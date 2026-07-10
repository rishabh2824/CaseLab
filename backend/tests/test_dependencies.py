"""get_current_admin / require_super_admin: the dependency every admin-only
route hangs off. Exercised through a tiny throwaway FastAPI app (not the real
app) so we're testing the dependency's own logic, with only the DB lookup
(`admin_repository.get_by_id`) mocked — the JWT decode, header parsing, and
role check are all real.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import api.dependencies as deps
from services import admin_auth
from tests.conftest import async_return


@pytest.fixture
def app(patched_db_client):
    app = FastAPI()

    @app.get("/whoami")
    async def whoami(admin: deps.CurrentAdmin = Depends(deps.get_current_admin)):
        return {"id": admin.id, "role": admin.role}

    @app.get("/super-only")
    async def super_only(admin: deps.CurrentAdmin = Depends(deps.require_super_admin)):
        return {"id": admin.id, "role": admin.role}

    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_missing_authorization_header_is_401(admin_env, client):
    resp = client.get("/whoami")
    assert resp.status_code == 401


def test_malformed_authorization_header_is_401(admin_env, client):
    resp = client.get("/whoami", headers={"Authorization": "Basic somethingelse"})
    assert resp.status_code == 401


def test_garbage_token_is_401(admin_env, client):
    resp = client.get("/whoami", headers=_bearer("not-a-real-jwt"))
    assert resp.status_code == 401


def test_valid_token_for_existing_admin_succeeds(admin_env, client, monkeypatch):
    token = admin_auth.create_admin_jwt("admin-1", role=2)
    monkeypatch.setattr(
        deps.admin_repository,
        "get_by_id",
        async_return(lambda c, admin_id: {"id": "admin-1", "email": "a@wisc.edu", "name": None, "role": 2}),
    )

    resp = client.get("/whoami", headers=_bearer(token))

    assert resp.status_code == 200
    assert resp.json() == {"id": "admin-1", "role": 2}


def test_valid_token_for_deleted_admin_is_401(admin_env, client, monkeypatch):
    # The whole point of re-fetching by id on every request: a JWT that is
    # still cryptographically valid but whose admin row was deleted must stop
    # working immediately, not linger until it naturally expires.
    token = admin_auth.create_admin_jwt("admin-1", role=2)
    monkeypatch.setattr(deps.admin_repository, "get_by_id", async_return(lambda c, admin_id: None))

    resp = client.get("/whoami", headers=_bearer(token))

    assert resp.status_code == 401


def test_expired_token_is_401(admin_env, client, monkeypatch):
    monkeypatch.setattr(admin_auth, "ADMIN_JWT_EXPIRY_SECONDS", -10)
    token = admin_auth.create_admin_jwt("admin-1", role=2)
    monkeypatch.setattr(
        deps.admin_repository,
        "get_by_id",
        async_return(lambda c, admin_id: {"id": "admin-1", "email": "a@wisc.edu", "name": None, "role": 2}),
    )

    resp = client.get("/whoami", headers=_bearer(token))

    assert resp.status_code == 401


def test_require_super_admin_allows_role_1(admin_env, client, monkeypatch):
    token = admin_auth.create_admin_jwt("super-1", role=1)
    monkeypatch.setattr(
        deps.admin_repository,
        "get_by_id",
        async_return(lambda c, admin_id: {"id": "super-1", "email": "s@wisc.edu", "name": None, "role": 1}),
    )

    resp = client.get("/super-only", headers=_bearer(token))

    assert resp.status_code == 200


def test_require_super_admin_rejects_role_2(admin_env, client, monkeypatch):
    token = admin_auth.create_admin_jwt("admin-1", role=2)
    monkeypatch.setattr(
        deps.admin_repository,
        "get_by_id",
        async_return(lambda c, admin_id: {"id": "admin-1", "email": "a@wisc.edu", "name": None, "role": 2}),
    )

    resp = client.get("/super-only", headers=_bearer(token))

    assert resp.status_code == 403
