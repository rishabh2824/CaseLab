"""JWT issuance/verification and Google ID-token verification for admin
sessions. Google's own network call (fetching signing certs) is mocked at
`admin_auth.google_id_token.verify_oauth2_token` — everything downstream of
that (domain allowlist check, email_verified check, our own JWT claims) is
real logic under test.
"""

import jwt
import pytest

from services import admin_auth


# --- our own session JWTs ---------------------------------------------------


def test_create_admin_jwt_roundtrips_through_decode(admin_env):
    token = admin_auth.create_admin_jwt("admin-123", role=1)
    payload = admin_auth.decode_admin_jwt(token)
    assert payload == {"admin_id": "admin-123", "role": 1}


def test_decode_admin_jwt_rejects_tampered_signature(admin_env):
    token = admin_auth.create_admin_jwt("admin-123", role=2)
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    with pytest.raises(admin_auth.InvalidAdminToken):
        admin_auth.decode_admin_jwt(tampered)


def test_decode_admin_jwt_rejects_expired_token(admin_env, monkeypatch):
    monkeypatch.setattr(admin_auth, "ADMIN_JWT_EXPIRY_SECONDS", -10)
    token = admin_auth.create_admin_jwt("admin-123", role=1)
    with pytest.raises(admin_auth.InvalidAdminToken):
        admin_auth.decode_admin_jwt(token)


def test_decode_admin_jwt_rejects_token_signed_with_a_different_secret(admin_env, monkeypatch):
    token = admin_auth.create_admin_jwt("admin-123", role=1)
    monkeypatch.setenv("ADMIN_JWT_SECRET", "a-totally-different-secret")
    from settings import get_settings

    get_settings.cache_clear()
    with pytest.raises(admin_auth.InvalidAdminToken):
        admin_auth.decode_admin_jwt(token)


def test_decode_admin_jwt_rejects_missing_role_claim(admin_env):
    from settings import get_settings

    bad_token = jwt.encode(
        {"admin_id": "admin-123"}, get_settings().admin_jwt_secret, algorithm="HS256"
    )
    with pytest.raises(admin_auth.InvalidAdminToken):
        admin_auth.decode_admin_jwt(bad_token)


def test_decode_admin_jwt_rejects_out_of_range_role(admin_env):
    from settings import get_settings

    bad_token = jwt.encode(
        {"admin_id": "admin-123", "role": 99},
        get_settings().admin_jwt_secret,
        algorithm="HS256",
    )
    with pytest.raises(admin_auth.InvalidAdminToken):
        admin_auth.decode_admin_jwt(bad_token)


def test_decode_admin_jwt_rejects_garbage_token(admin_env):
    with pytest.raises(admin_auth.InvalidAdminToken):
        admin_auth.decode_admin_jwt("not-a-jwt-at-all")


# --- Google ID token verification + domain allowlist ------------------------


def test_verify_google_id_token_returns_claims_for_allowed_domain(admin_env, monkeypatch):
    claims = {"email": "prof@wisc.edu", "hd": "wisc.edu", "email_verified": True}
    monkeypatch.setattr(
        admin_auth.google_id_token, "verify_oauth2_token", lambda *a, **k: claims
    )
    result = admin_auth.verify_google_id_token("fake-token")
    assert result["email"] == "prof@wisc.edu"


def test_verify_google_id_token_rejects_wrong_domain(admin_env, monkeypatch):
    claims = {"email": "someone@gmail.com", "hd": "gmail.com", "email_verified": True}
    monkeypatch.setattr(
        admin_auth.google_id_token, "verify_oauth2_token", lambda *a, **k: claims
    )
    with pytest.raises(admin_auth.GoogleTokenInvalid):
        admin_auth.verify_google_id_token("fake-token")


def test_verify_google_id_token_rejects_missing_hd_claim(admin_env, monkeypatch):
    # No `hd` claim means a personal/consumer Google account, not a Workspace
    # account — must not slip past the domain check.
    claims = {"email": "someone@wisc.edu", "email_verified": True}
    monkeypatch.setattr(
        admin_auth.google_id_token, "verify_oauth2_token", lambda *a, **k: claims
    )
    with pytest.raises(admin_auth.GoogleTokenInvalid):
        admin_auth.verify_google_id_token("fake-token")


def test_verify_google_id_token_rejects_unverified_email(admin_env, monkeypatch):
    claims = {"email": "prof@wisc.edu", "hd": "wisc.edu", "email_verified": False}
    monkeypatch.setattr(
        admin_auth.google_id_token, "verify_oauth2_token", lambda *a, **k: claims
    )
    with pytest.raises(admin_auth.GoogleTokenInvalid):
        admin_auth.verify_google_id_token("fake-token")


def test_verify_google_id_token_wraps_underlying_verification_failure(admin_env, monkeypatch):
    def _raise(*a, **k):
        raise ValueError("Token expired")

    monkeypatch.setattr(admin_auth.google_id_token, "verify_oauth2_token", _raise)
    with pytest.raises(admin_auth.GoogleTokenInvalid):
        admin_auth.verify_google_id_token("fake-token")


def test_verify_google_id_token_passes_our_client_id_as_audience(admin_env, monkeypatch):
    captured = {}

    def _capture(token, request, audience):
        captured["audience"] = audience
        return {"email": "prof@wisc.edu", "hd": "wisc.edu", "email_verified": True}

    monkeypatch.setattr(admin_auth.google_id_token, "verify_oauth2_token", _capture)
    admin_auth.verify_google_id_token("fake-token")
    assert captured["audience"] == "test-client-id.apps.googleusercontent.com"
