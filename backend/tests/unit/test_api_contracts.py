"""Request/response contract tests: pydantic validation on the way in,
response_model shaping on the way out, and the uploads presign endpoint's
key-building logic.

Reuses the `client`/`as_admin` fixtures defined in test_api_http.py rather
than duplicating them (see that file's module docstring for why they live
there instead of tests/unit/conftest.py).
"""

from __future__ import annotations

import pytest

import api.uploads as uploads_module
import services.cases as cases_service
from infra.settings import SIMULATION_DURATION
from tests import factories
from tests.unit.test_api_http import as_admin, client  # noqa: F401  (re-exported fixtures)


# ---------------------------------------------------------------------------
# malformed request bodies -> 422 from pydantic, never reaching the service
# ---------------------------------------------------------------------------


async def test_create_case_missing_required_field_returns_422(client, as_admin):  # noqa: F811
    as_admin()
    payload = factories.casePayload()
    del payload["case_name"]
    resp = await client.post("/api/cases", json=payload)
    assert resp.status_code == 422


@pytest.mark.parametrize("bad_duration", [0, -5, SIMULATION_DURATION + 1])
async def test_create_case_simulation_duration_out_of_range_returns_422(client, as_admin, bad_duration):  # noqa: F811
    as_admin()
    payload = factories.casePayload(simulation_duration=bad_duration)
    resp = await client.post("/api/cases", json=payload)
    assert resp.status_code == 422


async def test_create_case_simulation_duration_in_range_is_accepted_by_validation(client, as_admin, monkeypatch):  # noqa: F811
    """Companion to the out-of-range test above: 1 and SIMULATION_DURATION are
    the inclusive boundaries (`ge=1, le=SIMULATION_DURATION` on the field) --
    confirm pydantic doesn't also reject the edges themselves. The service
    call itself is stubbed out since only request validation is under test."""
    as_admin()

    async def fake_create(session, payload, admin):
        return {"case_id": 1}

    monkeypatch.setattr(cases_service, "createCase", fake_create)
    for boundary in (1, SIMULATION_DURATION):
        payload = factories.casePayload(simulation_duration=boundary)
        resp = await client.post("/api/cases", json=payload)
        assert resp.status_code == 200, (boundary, resp.text)


# ---------------------------------------------------------------------------
# response_model actually strips fields the service didn't declare
# ---------------------------------------------------------------------------


async def test_response_model_strips_extra_fields_the_service_returns(client, as_admin, monkeypatch):  # noqa: F811
    """Nothing else in this codebase checks that response_model= is doing its
    job -- a service function is free to return extra keys (a leftover debug
    field, an internal id) and, absent this test, nobody would notice they
    leaked to the browser. GET /api/cases/{case_id}'s response_model is
    CaseDetailResponse -> CaseDetail, neither of which declare `secret_field`
    or `debug_note`, so both must disappear from the JSON actually sent."""
    as_admin()

    async def fake_get_case(session, case_id, admin):
        return {
            "case": {
                "id": case_id,
                "case_name": "Sterling Industries",
                "access_code": None,
                "initial_brief": "brief",
                "common_information": None,
                "simulation_duration": None,
                "personas": [],
                "referrals": [],
                "roots": [],
                "version": 1,
                "owner_admin_id": 1,
                "collaborator_admin_ids": [],
                "secret_field": "must not leak to the browser",
            },
            "debug_note": "also must not leak",
        }

    monkeypatch.setattr(cases_service, "getCase", fake_get_case)
    resp = await client.get("/api/cases/1")
    assert resp.status_code == 200
    body = resp.json()
    assert "debug_note" not in body
    assert "secret_field" not in body["case"]
    assert body["case"]["case_name"] == "Sterling Industries"


# ---------------------------------------------------------------------------
# POST /api/uploads/presign
# ---------------------------------------------------------------------------


async def test_presign_preserves_extension_and_applies_prefix(client, as_admin, monkeypatch):  # noqa: F811
    as_admin()
    monkeypatch.setattr(uploads_module, "putUrl", lambda object_key, content_type=None: "https://signed.test/put")

    resp = await client.post(
        "/api/uploads/presign",
        json={"file_name": "Photo.PNG", "content_type": "image/png", "prefix": "cases/42/personas"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["object_key"].startswith("cases/42/personas/")
    assert body["object_key"].endswith(".png")  # extension preserved, lower-cased
    assert body["file_name"] == "Photo.PNG"  # the *display* name is untouched


async def test_presign_strips_leading_and_trailing_slashes_from_prefix(client, as_admin, monkeypatch):  # noqa: F811
    as_admin()
    monkeypatch.setattr(uploads_module, "putUrl", lambda object_key, content_type=None: "https://signed.test/put")

    resp = await client.post("/api/uploads/presign", json={"file_name": "a.png", "prefix": "/cases/42/"})
    assert resp.status_code == 200
    object_key = resp.json()["object_key"]
    assert object_key.startswith("cases/42/")
    assert not object_key.startswith("/")


@pytest.mark.xfail(
    strict=True,
    reason=(
        "GENUINE BUG (not fixed here per task instructions): api/uploads.py's "
        "presign_upload does `safe_prefix = payload.prefix.strip('/')`, which "
        "only trims leading/trailing slash CHARACTERS -- it does not neutralize "
        "'..' path segments. A prefix of '../../etc/passwd' round-trips through "
        "unchanged, so the resulting object_key ('../../etc/passwd/<uuid>.ext') "
        "escapes the intended upload folder entirely. This test documents the "
        "escape with strict xfail so a future fix (e.g. rejecting/collapsing '..' "
        "segments) turns it into a visible XPASS failure instead of silently "
        "leaving the hole unverified."
    ),
)
async def test_presign_prefix_cannot_escape_intended_folder(client, as_admin, monkeypatch):  # noqa: F811
    as_admin()
    monkeypatch.setattr(uploads_module, "putUrl", lambda object_key, content_type=None: "https://signed.test/put")

    resp = await client.post("/api/uploads/presign", json={"file_name": "a.png", "prefix": "../../etc/passwd"})
    assert resp.status_code == 200
    object_key = resp.json()["object_key"]
    assert not object_key.startswith("../"), object_key
    assert ".." not in object_key.split("/"), object_key
