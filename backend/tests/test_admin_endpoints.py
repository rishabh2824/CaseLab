"""POST /api/admin/login and the super-admin-only admin-management endpoints,
exercised through a throwaway FastAPI app mounting only api.admin's router
(not the full app — no LLM client, no background sweeper, no CORS setup to
fight with).

Google's network call is mocked (`api.admin.verify_google_id_token`); the
allowlist lookup against our own DB (`admin_repository.get_by_email`/
`get_by_id`) is mocked at the repository boundary too, but everything in
between — deciding 401 vs 200, minting the JWT, super-admin gating — is real.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.admin as admin_module
from services import admin_auth
from tests.conftest import async_return

GOOGLE_CLAIMS = {"email": "prof@wisc.edu", "hd": "wisc.edu", "email_verified": True}


@pytest.fixture
def app(patched_db_client):
    # admin_module.router already carries prefix="/admin" (see api/admin.py),
    # matching how api/router.py mounts it under /api.
    app = FastAPI()
    app.include_router(admin_module.router, prefix="/api")
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def _mock_google(monkeypatch, claims=None, error=None):
    if error is not None:
        def _raise(token):
            raise error
        monkeypatch.setattr(admin_module, "verify_google_id_token", _raise)
    else:
        monkeypatch.setattr(admin_module, "verify_google_id_token", lambda token: claims or GOOGLE_CLAIMS)


def _super_admin_headers(admin_id="super-1"):
    token = admin_auth.create_admin_jwt(admin_id, role=1)
    return {"Authorization": f"Bearer {token}"}


def _regular_admin_headers(admin_id="admin-2"):
    token = admin_auth.create_admin_jwt(admin_id, role=2)
    return {"Authorization": f"Bearer {token}"}


# --- POST /login -------------------------------------------------------


class TestLogin:
    def test_allowlisted_admin_gets_a_working_jwt(self, admin_env, client, monkeypatch):
        _mock_google(monkeypatch)
        admin_row = {"id": "admin-1", "email": "prof@wisc.edu", "name": "Prof X", "role": 2}
        monkeypatch.setattr(admin_module.admin_repository, "get_by_email", async_return(lambda c, e: admin_row))

        resp = client.post("/api/admin/login", json={"google_id_token": "fake"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["role"] == 2
        assert body["email"] == "prof@wisc.edu"
        assert body["admin_id"] == "admin-1"
        decoded = admin_auth.decode_admin_jwt(body["admin_jwt"])
        assert decoded == {"admin_id": "admin-1", "role": 2}

    def test_non_allowlisted_email_is_401(self, admin_env, client, monkeypatch):
        _mock_google(monkeypatch)
        monkeypatch.setattr(admin_module.admin_repository, "get_by_email", async_return(lambda c, e: None))

        resp = client.post("/api/admin/login", json={"google_id_token": "fake"})

        assert resp.status_code == 401

    def test_google_verification_failure_is_401_and_never_checks_allowlist(
        self, admin_env, client, monkeypatch
    ):
        _mock_google(monkeypatch, error=admin_auth.GoogleTokenInvalid("wrong domain"))
        calls = []
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_email",
            async_return(lambda c, e: calls.append(e) or None),
        )

        resp = client.post("/api/admin/login", json={"google_id_token": "fake"})

        assert resp.status_code == 401
        assert calls == []  # allowlist DB lookup never reached

    def test_super_admin_login_returns_role_1(self, admin_env, client, monkeypatch):
        _mock_google(monkeypatch, claims={"email": "boss@wisc.edu", "hd": "wisc.edu", "email_verified": True})
        admin_row = {"id": "super-1", "email": "boss@wisc.edu", "name": None, "role": 1}
        monkeypatch.setattr(admin_module.admin_repository, "get_by_email", async_return(lambda c, e: admin_row))

        resp = client.post("/api/admin/login", json={"google_id_token": "fake"})

        assert resp.status_code == 200
        assert resp.json()["role"] == 1


# --- super-admin-only /admins management -------------------------------


class TestAdminManagement:
    def test_list_admins_requires_super_admin(self, admin_env, client, monkeypatch):
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_id",
            async_return(lambda c, i: {"id": i, "email": "a@wisc.edu", "name": None, "role": 2}),
        )
        resp = client.get("/api/admin/admins", headers=_regular_admin_headers())
        assert resp.status_code == 403

    def test_list_admins_succeeds_for_super_admin(self, admin_env, client, monkeypatch):
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_id",
            async_return(lambda c, i: {"id": i, "email": "s@wisc.edu", "name": None, "role": 1}),
        )
        rows = [{"id": "a1", "email": "a@wisc.edu", "name": "A", "role": 2}]
        monkeypatch.setattr(admin_module.admin_repository, "list_all", async_return(lambda c: rows))

        resp = client.get("/api/admin/admins", headers=_super_admin_headers())

        assert resp.status_code == 200
        assert resp.json() == rows

    def test_add_admin_requires_super_admin(self, admin_env, client, monkeypatch):
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_id",
            async_return(lambda c, i: {"id": i, "email": "a@wisc.edu", "name": None, "role": 2}),
        )
        resp = client.post(
            "/api/admin/admins",
            json={"email": "new@wisc.edu", "name": "New Admin", "role": 2},
            headers=_regular_admin_headers(),
        )
        assert resp.status_code == 403

    def test_add_admin_succeeds_for_super_admin(self, admin_env, client, monkeypatch):
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_id",
            async_return(lambda c, i: {"id": i, "email": "s@wisc.edu", "name": None, "role": 1}),
        )
        monkeypatch.setattr(admin_module.admin_repository, "get_by_email", async_return(lambda c, e: None))
        created = {"id": "new-1", "email": "new@wisc.edu", "name": "New Admin", "role": 2}
        monkeypatch.setattr(
            admin_module.admin_repository,
            "create",
            async_return(lambda c, email, name, role: created),
        )

        resp = client.post(
            "/api/admin/admins",
            json={"email": "new@wisc.edu", "name": "New Admin", "role": 2},
            headers=_super_admin_headers(),
        )

        assert resp.status_code == 200
        assert resp.json() == created

    def test_add_admin_rejects_duplicate_email(self, admin_env, client, monkeypatch):
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_id",
            async_return(lambda c, i: {"id": i, "email": "s@wisc.edu", "name": None, "role": 1}),
        )
        existing = {"id": "existing-1", "email": "new@wisc.edu", "name": None, "role": 2}
        monkeypatch.setattr(admin_module.admin_repository, "get_by_email", async_return(lambda c, e: existing))

        resp = client.post(
            "/api/admin/admins",
            json={"email": "new@wisc.edu", "name": "New Admin", "role": 2},
            headers=_super_admin_headers(),
        )

        assert resp.status_code == 409

    def test_add_admin_rejects_invalid_role(self, admin_env, client, monkeypatch):
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_id",
            async_return(lambda c, i: {"id": i, "email": "s@wisc.edu", "name": None, "role": 1}),
        )

        resp = client.post(
            "/api/admin/admins",
            json={"email": "new@wisc.edu", "name": "New Admin", "role": 3},
            headers=_super_admin_headers(),
        )

        assert resp.status_code == 422

    def test_delete_admin_requires_super_admin(self, admin_env, client, monkeypatch):
        monkeypatch.setattr(
            admin_module.admin_repository,
            "get_by_id",
            async_return(lambda c, i: {"id": i, "email": "a@wisc.edu", "name": None, "role": 2}),
        )
        resp = client.delete("/api/admin/admins/some-id", headers=_regular_admin_headers())
        assert resp.status_code == 403

    def test_delete_admin_succeeds_for_super_admin(self, admin_env, client, monkeypatch):
        target = {"id": "target-1", "email": "t@wisc.edu", "name": None, "role": 2}

        async def fake_get_by_id(c, admin_id):
            # First call resolves the requester (super-1); second resolves the target.
            if admin_id == "super-1":
                return {"id": "super-1", "email": "s@wisc.edu", "name": None, "role": 1}
            return target if admin_id == "target-1" else None

        monkeypatch.setattr(admin_module.admin_repository, "get_by_id", fake_get_by_id)
        deleted = []
        monkeypatch.setattr(
            admin_module.admin_repository, "delete", async_return(lambda c, i: deleted.append(i))
        )

        resp = client.delete("/api/admin/admins/target-1", headers=_super_admin_headers())

        assert resp.status_code == 200
        assert deleted == ["target-1"]

    def test_delete_nonexistent_admin_is_404(self, admin_env, client, monkeypatch):
        async def fake_get_by_id(c, admin_id):
            if admin_id == "super-1":
                return {"id": "super-1", "email": "s@wisc.edu", "name": None, "role": 1}
            return None

        monkeypatch.setattr(admin_module.admin_repository, "get_by_id", fake_get_by_id)

        resp = client.delete("/api/admin/admins/ghost", headers=_super_admin_headers())

        assert resp.status_code == 404
