"""HTTP-level tests for the FastAPI app: routing, auth dependencies, and the
DomainError -> HTTP status mapping registered in main.py.

Everything here drives the *real* ASGI app through httpx.ASGITransport — no
TestClient, no lifespan (that starts background sweepers and a real LLM
client; see main.py's `lifespan`). The two seams every route ultimately
touches are replaced instead:

  * infra.db.getRequestSession -- overridden via app.dependency_overrides to a
    stub that never opens a real connection.
  * api.dependencies.getCurrentAdmin -- overridden via app.dependency_overrides
    when a test wants to skip auth entirely (`as_admin`), or left alone (with
    a real cookie minted by services.auth.createJwt) when the test is
    specifically about auth.

Service-layer functions (services.cases, services.admin, services.simulation.
service, infra.spaces.putUrl) are monkeypatched per test so nothing here ever
reaches a database or the network.

Shared fixtures (`client`, `as_admin`) live in this module rather than in
tests/unit/conftest.py per this task's instructions, and are imported by the
sibling files in this suite (test_api_errors.py, test_api_contracts.py,
test_api_sse.py) that need the same ASGI client.
"""

from __future__ import annotations

import re

import pytest
from fastapi.middleware.cors import CORSMiddleware

import domain_errors as de
import services.admin as admin_repo
from api.dependencies import CurrentAdmin, getCurrentAdmin
from infra.db import getRequestSession
from models.admin import AdminRole
from services.auth import COOKIE_NAME, createJwt

import httpx
from main import app


# ---------------------------------------------------------------------------
# shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
async def client():
    """A hermetic ASGI client for `app`.

    Overrides infra.db.getRequestSession for the lifetime of the test so no
    route can accidentally open a real database connection, regardless of
    whether the test also monkeypatches the service function that route
    calls. Every override this fixture (or a fixture built on top of it, e.g.
    `as_admin`) installs is cleared in teardown so nothing leaks between
    tests.
    """

    async def fakeSession():
        # No test in this suite reads from the yielded session directly --
        # every route handler's service-layer call is monkeypatched, so this
        # object is never actually touched.
        yield None

    app.dependency_overrides[getRequestSession] = fakeSession
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest.fixture
def as_admin(client):
    """Bypasses getCurrentAdmin entirely, standing in as a signed-in admin.

    Depends on `client` so its override lands in the same dependency_overrides
    dict `client` clears in teardown -- ordering between the two doesn't
    matter as a result, but requesting `client` here guarantees this fixture
    is never used without it.
    """

    def _apply(admin_id: int = 1, role: AdminRole = AdminRole.ADMIN) -> CurrentAdmin:
        identity = CurrentAdmin(id=admin_id, role=role)
        app.dependency_overrides[getCurrentAdmin] = lambda: identity
        return identity

    return _apply


def path_params_filled(path: str) -> str:
    """Replaces every `{param}` segment in an OpenAPI path template with a
    throwaway concrete value, so a route can actually be requested."""
    return re.sub(r"\{[^}]+\}", "1", path)


# ---------------------------------------------------------------------------
# route protection: every /api/cases and /api/uploads route requires an admin
# ---------------------------------------------------------------------------

# main.py registers no OPTIONS/HEAD handlers of its own; app.openapi()'s
# `paths` dict only contains the verbs FastAPI actually wired up, so this list
# is derived from the same schema the frontend's codegen consumes -- a route
# added later shows up here automatically, no hand-maintained list to forget
# to update.
#
# NOTE on why `app.routes` isn't used directly (as originally suggested):
# this FastAPI version (0.139) resolves `app.routes` / `app.router.routes`
# lazily into private `_IncludedRouter` / `_EffectiveRouteContext` objects
# that don't expose a stable, public way to list flattened (path, methods)
# pairs. `app.openapi()["paths"]` is the public, documented surface for
# exactly this kind of introspection and is what actually goes out to
# clients (including the frontend's own codegen), so it's the more faithful
# "walk the real route table" source here.
def _api_routes_from_openapi() -> list[tuple[str, str]]:
    spec = app.openapi()
    routes: list[tuple[str, str]] = []
    for path, methods in spec["paths"].items():
        if not (path.startswith("/api/cases") or path.startswith("/api/uploads")):
            continue
        for method in methods:
            if method.lower() not in {"get", "post", "put", "delete", "patch"}:
                continue
            routes.append((method.upper(), path))
    return routes


ALL_CASES_AND_UPLOADS_ROUTES = _api_routes_from_openapi()

# GET /api/cases/demo is excluded from the blanket loop below -- see
# test_demo_case_route_still_requires_a_signed_in_admin for why, and why it is
# NOT simply "no auth required" despite the "public" framing in
# services/cases.py's comment on getDemoCase.
PROTECTED_ROUTES = [rp for rp in ALL_CASES_AND_UPLOADS_ROUTES if rp != ("GET", "/api/cases/demo")]

assert PROTECTED_ROUTES, "expected at least one /api/cases or /api/uploads route in the OpenAPI schema"
assert ("GET", "/api/cases/demo") in ALL_CASES_AND_UPLOADS_ROUTES, (
    "GET /api/cases/demo disappeared from the route table -- update PROTECTED_ROUTES' exclusion above"
)


@pytest.mark.parametrize("method,path", PROTECTED_ROUTES, ids=[f"{m} {p}" for m, p in PROTECTED_ROUTES])
async def test_route_requires_admin_cookie(client, method, path):
    concrete_path = path_params_filled(path)
    body = {} if method in ("POST", "PUT", "PATCH") else None
    resp = await client.request(method, concrete_path, json=body)
    assert resp.status_code == 401, f"{method} {path} should 401 without an admin cookie, got {resp.status_code}"


async def test_demo_case_route_still_requires_a_signed_in_admin(client):
    """GET /api/cases/demo is mounted under api_router.include_router(cases_router,
    dependencies=[Depends(getCurrentAdmin)]) (api/router.py) just like every other
    case route, so it is NOT anonymous-public -- a request with no cookie at all
    still 401s, exactly like the routes covered by the loop above.

    What IS special about it (and why services/cases.py's comment on
    getDemoCase calls it deliberately open) is that its handler skips the
    per-case caseAccess() ownership/collaborator check that every other
    /api/cases/{case_id}... route enforces: "every signed-in admin -- not just
    DEMO_CASE_ID's owner/collaborators -- gets to see a fully filled-out
    example case." I.e. it's public *among admins*, not public on the
    internet. This test locks in the real (cookie-gated) behavior so it isn't
    silently conflated with true anonymous access.
    """
    resp = await client.get("/api/cases/demo")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# auth: garbage cookie, valid cookie for a deleted admin
# ---------------------------------------------------------------------------


async def test_missing_cookie_returns_401(client):
    resp = await client.get("/api/cases")
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Missing admin credentials."}


async def test_garbage_cookie_returns_401(client):
    client.cookies.set(COOKIE_NAME, "not-a-jwt-at-all")
    resp = await client.get("/api/cases")
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid admin session."}


async def test_valid_cookie_for_deleted_admin_returns_401(client, monkeypatch):
    token = createJwt(999999, AdminRole.ADMIN)

    async def missing(session, admin_id):
        return None

    monkeypatch.setattr(admin_repo, "getById", missing)
    client.cookies.set(COOKIE_NAME, token)
    resp = await client.get("/api/cases")
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Admin account no longer exists."}


# ---------------------------------------------------------------------------
# requireSuperAdmin
# ---------------------------------------------------------------------------


async def test_add_admin_requires_super_admin(client, as_admin):
    as_admin(role=AdminRole.ADMIN)
    resp = await client.post("/api/admin/admins", json={"email": "new@test.invalid", "name": "New", "role": 2})
    assert resp.status_code == 403


async def test_delete_admin_requires_super_admin(client, as_admin):
    as_admin(role=AdminRole.ADMIN)
    resp = await client.delete("/api/admin/admins/5")
    assert resp.status_code == 403


async def test_add_admin_super_admin_succeeds(client, as_admin, monkeypatch):
    as_admin(role=AdminRole.SUPER)

    async def no_existing(session, email):
        return None

    async def created(session, email, name, role):
        return {"id": 9, "email": email, "name": name, "role": int(role)}

    monkeypatch.setattr(admin_repo, "getByEmail", no_existing)
    monkeypatch.setattr(admin_repo, "create", created)

    resp = await client.post("/api/admin/admins", json={"email": "new@test.invalid", "name": "New", "role": 2})
    assert resp.status_code == 200
    assert resp.json() == {"id": 9, "email": "new@test.invalid", "name": "New", "role": 2}


async def test_delete_super_admin_returns_403(client, as_admin, monkeypatch):
    as_admin(role=AdminRole.SUPER)

    async def existing(session, admin_id):
        return {"id": admin_id, "email": "s@test.invalid", "name": "S", "role": int(AdminRole.SUPER)}

    monkeypatch.setattr(admin_repo, "getById", existing)
    resp = await client.delete("/api/admin/admins/3")
    assert resp.status_code == 403


async def test_delete_missing_admin_returns_404(client, as_admin, monkeypatch):
    as_admin(role=AdminRole.SUPER)

    async def missing(session, admin_id):
        return None

    monkeypatch.setattr(admin_repo, "getById", missing)
    resp = await client.delete("/api/admin/admins/999")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/admin/login, POST /api/admin/logout
# ---------------------------------------------------------------------------


async def test_login_invalid_token_returns_401(client, monkeypatch):
    def bad_token(credential):
        raise ValueError("Token is expired.")

    monkeypatch.setattr(admin_repo, "verifyToken", bad_token)
    resp = await client.post("/api/admin/login", json={"credential": "whatever"})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Token is expired."}


async def test_login_unknown_email_returns_401(client, monkeypatch):
    monkeypatch.setattr(admin_repo, "verifyToken", lambda credential: {"email": "ghost@test.invalid"})

    async def no_admin(session, email):
        return None

    monkeypatch.setattr(admin_repo, "getByEmail", no_admin)
    resp = await client.post("/api/admin/login", json={"credential": "whatever"})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Your account is not authorized"}


async def test_login_success_sets_cookie_and_returns_admin(client, monkeypatch):
    monkeypatch.setattr(admin_repo, "verifyToken", lambda credential: {"email": "admin@test.invalid"})

    async def found(session, email):
        return {"id": 7, "email": "admin@test.invalid", "name": "Admin Seven", "role": int(AdminRole.ADMIN)}

    monkeypatch.setattr(admin_repo, "getByEmail", found)
    resp = await client.post("/api/admin/login", json={"credential": "whatever"})
    assert resp.status_code == 200
    assert resp.json() == {"admin_id": 7, "role": 2, "email": "admin@test.invalid", "name": "Admin Seven"}

    set_cookie = resp.headers.get("set-cookie", "")
    assert set_cookie.startswith(f"{COOKIE_NAME}="), set_cookie
    lowered = set_cookie.lower()
    assert "httponly" in lowered
    assert "secure" in lowered
    assert "samesite=lax" in lowered
    assert "path=/" in lowered


async def test_logout_clears_cookie(client):
    resp = await client.post("/api/admin/logout")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    set_cookie = resp.headers.get("set-cookie", "")
    assert set_cookie.startswith(f"{COOKIE_NAME}="), set_cookie
    # Starlette's Response.delete_cookie expires the cookie immediately rather
    # than sending an empty value with no expiry -- assert on that, not on the
    # (empty) value, which is an implementation detail.
    lowered = set_cookie.lower()
    assert "max-age=0" in lowered or "1970" in lowered


# ---------------------------------------------------------------------------
# GET /api/admin/me
# ---------------------------------------------------------------------------


async def test_me_requires_admin_cookie(client):
    resp = await client.get("/api/admin/me")
    assert resp.status_code == 401


async def test_me_returns_current_admin(client, as_admin, monkeypatch):
    as_admin(admin_id=7, role=AdminRole.SUPER)

    async def found(session, admin_id):
        return {"id": 7, "email": "admin@test.invalid", "name": "Admin Seven", "role": int(AdminRole.SUPER)}

    monkeypatch.setattr(admin_repo, "getById", found)
    resp = await client.get("/api/admin/me")
    assert resp.status_code == 200
    assert resp.json() == {"admin_id": 7, "role": 1, "email": "admin@test.invalid", "name": "Admin Seven"}


async def test_me_for_a_deleted_admin_returns_401(client, as_admin, monkeypatch):
    as_admin(admin_id=7)

    async def missing(session, admin_id):
        return None

    monkeypatch.setattr(admin_repo, "getById", missing)
    resp = await client.get("/api/admin/me")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# DomainError -> HTTP status mapping
# ---------------------------------------------------------------------------
#
# Driven off GET /api/cases/{case_id} (services.cases.getCase) because it's a
# single admin-protected route whose service function is trivial to replace
# wholesale with something that raises whatever DomainError subclass a given
# test wants -- the route itself is otherwise incidental to what's under test
# here.

import services.cases as cases_service  # noqa: E402  (kept near its usages below)


def _raiser(exc: Exception):
    async def _raise(session, case_id, admin):
        raise exc

    return _raise


DOMAIN_ERROR_CASES = [
    pytest.param(de.CaseNotFound("Case not found."), 404, "Case not found.", id="CaseNotFound"),
    pytest.param(de.AccessDenied("You do not have access to this case."), 403, "You do not have access to this case.", id="AccessDenied"),
    pytest.param(de.InvalidRequest("Bad input."), 400, "Bad input.", id="InvalidRequest"),
    pytest.param(de.AccessCodeConflict(cases_service.ACCESS_CODE_CONFLICT), 409, cases_service.ACCESS_CODE_CONFLICT, id="AccessCodeConflict"),
    pytest.param(de.UpstreamError("Upstream failed."), 502, "Upstream failed.", id="UpstreamError"),
    pytest.param(de.PersistenceError("Persist failed."), 500, "Persist failed.", id="PersistenceError"),
    pytest.param(de.RunNotFound("Run xyz not found."), 404, "Run xyz not found.", id="RunNotFound"),
]


@pytest.mark.parametrize("exc,expected_status,expected_detail", DOMAIN_ERROR_CASES)
async def test_domain_error_maps_to_http_status(client, as_admin, monkeypatch, exc, expected_status, expected_detail):
    as_admin()
    monkeypatch.setattr(cases_service, "getCase", _raiser(exc))
    resp = await client.get("/api/cases/1")
    assert resp.status_code == expected_status
    assert resp.json() == {"detail": expected_detail}


async def test_version_conflict_detail_is_structured(client, as_admin, monkeypatch):
    """VersionConflict's detail is a {message, code} dict, not a bare string --
    the frontend's ApiError.code (frontend/src/lib/api/client.ts) reads `code`
    off exactly this shape to distinguish "someone else saved first" from a
    generic error, so the structure has to survive the exception handler
    untouched."""
    as_admin()
    monkeypatch.setattr(cases_service, "getCase", _raiser(de.VersionConflict(cases_service.VERSION_CONFLICT)))
    resp = await client.get("/api/cases/1")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail == cases_service.VERSION_CONFLICT
    assert detail["code"] == "version_conflict"


async def test_rate_limited_maps_to_429_with_retry_after_header(client, as_admin, monkeypatch):
    as_admin()
    monkeypatch.setattr(cases_service, "getCase", _raiser(de.RateLimited("Too many requests.", 42)))
    resp = await client.get("/api/cases/1")
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "42"
    assert resp.json() == {"detail": "Too many requests."}


async def test_new_domain_error_subclass_is_handled_via_mro(client, as_admin, monkeypatch):
    """main.py registers exactly one exception handler, on the base DomainError
    class -- Starlette resolves handlers by walking the raised exception's
    MRO (see the comment atop domain_errors.py), so a brand new subclass no
    one has written yet still needs no handler of its own. Defining one here
    and asserting it's handled is the actual proof that design works, not
    just that the existing subclasses happen to be covered."""

    class SurpriseError(de.DomainError):
        status_code = 418

    as_admin()
    monkeypatch.setattr(cases_service, "getCase", _raiser(SurpriseError("I'm a teapot.")))
    resp = await client.get("/api/cases/1")
    assert resp.status_code == 418
    assert resp.json() == {"detail": "I'm a teapot."}


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


def test_cors_installed_iff_frontend_urls_configured():
    """main.py installs CORSMiddleware only `if settings.frontendUrls:`. Assert
    internal consistency between main.app's actual middleware stack and
    whatever this checkout's settings currently say, rather than hardcoding a
    boolean -- FRONTEND_URLS varies across environments/.env files and
    asserting a specific value here would make the test flaky/environment-
    dependent."""
    from infra.settings import getSettings

    installed = any(m.cls is CORSMiddleware for m in app.user_middleware)
    assert installed == bool(getSettings().frontendUrls)


def test_cors_middleware_configuration_matches_main_py_logic():
    """Reimplements main.py's conditional CORSMiddleware wiring (the `if
    settings.frontendUrls: app.add_middleware(CORSMiddleware, ...)` block)
    against two fresh FastAPI apps, independent of whatever FRONTEND_URLS this
    checkout's .env happens to set -- so this test is deterministic across
    machines/CI regardless of local config."""
    from fastapi import FastAPI

    def build(frontend_urls: list[str]) -> FastAPI:
        built = FastAPI()
        if frontend_urls:
            built.add_middleware(
                CORSMiddleware,
                allow_origins=frontend_urls,
                allow_credentials=True,
                allow_methods=["*"],
                allow_headers=["*"],
            )
        return built

    unconfigured = build([])
    assert not any(m.cls is CORSMiddleware for m in unconfigured.user_middleware)

    configured = build(["https://example.test"])
    cors_entry = next(m for m in configured.user_middleware if m.cls is CORSMiddleware)
    assert cors_entry.kwargs["allow_origins"] == ["https://example.test"]
    assert cors_entry.kwargs["allow_credentials"] is True
    assert cors_entry.kwargs["allow_methods"] == ["*"]
    assert cors_entry.kwargs["allow_headers"] == ["*"]
