"""services/auth.py — JWT issuing/verification and the cookie attributes that
keep the admin session cookie from being readable by JS or sent cross-site.

No network: verifyToken's call to Google is monkeypatched away rather than
exercised for real.
"""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi import Response

from infra.settings import JWT_ALGORITHM, getSettings
from models.admin import AdminRole
from services import auth as auth_module


def realSecret() -> str:
    return getSettings().jwt_secret


# --------------------------------------------------------------------------
# createJwt / decodeJwt round trip
# --------------------------------------------------------------------------


def test_create_and_decode_jwt_round_trips_super_admin():
    token = auth_module.createJwt(7, AdminRole.SUPER)
    assert auth_module.decodeJwt(token) == {"admin_id": 7, "role": AdminRole.SUPER}


def test_create_and_decode_jwt_round_trips_regular_admin():
    token = auth_module.createJwt(3, AdminRole.ADMIN)
    assert auth_module.decodeJwt(token) == {"admin_id": 3, "role": AdminRole.ADMIN}


def test_decode_jwt_rejects_token_signed_with_a_different_secret():
    now = int(time.time())
    bogus = jwt.encode(
        {"admin_id": 1, "role": AdminRole.ADMIN, "iat": now, "exp": now + 3600},
        "a-completely-different-secret-value-1234567890",
        algorithm=JWT_ALGORITHM,
    )
    with pytest.raises(ValueError):
        auth_module.decodeJwt(bogus)


def test_decode_jwt_rejects_a_tampered_payload():
    token = auth_module.createJwt(1, AdminRole.ADMIN)
    header_b64, payload_b64, sig_b64 = token.split(".")
    # Flip the last character of the payload segment so the signature no
    # longer matches what was actually signed.
    flipped = "A" if payload_b64[-1] != "A" else "B"
    tampered = f"{header_b64}.{payload_b64[:-1]}{flipped}.{sig_b64}"
    with pytest.raises(ValueError):
        auth_module.decodeJwt(tampered)


def test_decode_jwt_rejects_an_expired_token():
    # Craft the exp claim directly with the real secret so only the
    # expiration check is under test, not the signature.
    now = int(time.time())
    token = jwt.encode(
        {"admin_id": 1, "role": AdminRole.ADMIN, "iat": now - 100, "exp": now - 50},
        realSecret(),
        algorithm=JWT_ALGORITHM,
    )
    with pytest.raises(ValueError):
        auth_module.decodeJwt(token)


def test_decode_jwt_rejects_missing_admin_id():
    now = int(time.time())
    token = jwt.encode(
        {"role": AdminRole.ADMIN, "iat": now, "exp": now + 3600},
        realSecret(),
        algorithm=JWT_ALGORITHM,
    )
    with pytest.raises(ValueError):
        auth_module.decodeJwt(token)


def test_decode_jwt_rejects_out_of_range_role():
    now = int(time.time())
    token = jwt.encode(
        {"admin_id": 1, "role": 999, "iat": now, "exp": now + 3600},
        realSecret(),
        algorithm=JWT_ALGORITHM,
    )
    with pytest.raises(ValueError):
        auth_module.decodeJwt(token)


# --------------------------------------------------------------------------
# setCookie / clearCookie
# --------------------------------------------------------------------------


def test_set_cookie_sets_the_security_attributes_that_matter():
    response = Response()
    auth_module.setCookie(response, "tok123")
    cookies = response.headers.getlist("set-cookie")
    assert len(cookies) == 1
    cookie = cookies[0]
    assert "HttpOnly" in cookie
    assert "Secure" in cookie
    assert "SameSite=lax" in cookie
    assert "Path=/" in cookie


def test_clear_cookie_sets_secure_samesite_and_path():
    # clearCookie doesn't pass httponly (Starlette's delete_cookie defaults
    # it to False) — a cleared cookie carries no value to protect, so this
    # isn't asserted here; Secure/SameSite/Path are what matter for a delete.
    response = Response()
    auth_module.clearCookie(response)
    cookies = response.headers.getlist("set-cookie")
    assert len(cookies) == 1
    cookie = cookies[0]
    assert "Secure" in cookie
    assert "SameSite=lax" in cookie
    assert "Path=/" in cookie
    assert "Max-Age=0" in cookie


# --------------------------------------------------------------------------
# verifyToken
# --------------------------------------------------------------------------


def test_verify_token_rejects_unverified_email(monkeypatch):
    def fakeVerify(token, request, client_id):
        return {"email_verified": False, "email": "x@y.com"}

    monkeypatch.setattr(auth_module.google_id_token, "verify_oauth2_token", fakeVerify)
    with pytest.raises(ValueError):
        auth_module.verifyToken("sometoken")


def test_verify_token_returns_claims_when_verified(monkeypatch):
    claims = {"email_verified": True, "email": "x@y.com", "name": "X"}

    def fakeVerify(token, request, client_id):
        return claims

    monkeypatch.setattr(auth_module.google_id_token, "verify_oauth2_token", fakeVerify)
    assert auth_module.verifyToken("sometoken") == claims
