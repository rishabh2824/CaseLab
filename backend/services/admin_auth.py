"""Admin session JWTs, and the Google ID-token verification boundary.

Two separate concerns live here, both auth-critical:

1. Our own session JWT (issued by ``POST /api/admin/login``, checked on every
   admin request by ``api.dependencies.get_current_admin``). Short-lived and
   signed with ``ADMIN_JWT_SECRET`` — see settings.py for why the expiry is
   just a cap (a deleted admin's token stops working immediately regardless,
   since the dependency re-fetches the admin row on every request).
2. Verifying a Google ID token the frontend hands us after Google Sign-In,
   including the Workspace-domain allowlist check (the ``hd`` claim) that is
   defense-in-depth alongside the ``admins`` table lookup done by the caller.

``verify_google_id_token`` calls out to Google over the network (to fetch/
verify against Google's signing certs) via
``google.oauth2.id_token.verify_oauth2_token`` — that single call is the
boundary tests mock; the domain/verified-email checks around it are real
logic and are tested as such.
"""

from __future__ import annotations

import time
from typing import NamedTuple, TypedDict

import jwt
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from settings import ADMIN_JWT_ALGORITHM, ADMIN_JWT_EXPIRY_SECONDS, get_settings

_VALID_ROLES = (1, 2)  # 1 = super admin, 2 = admin (matches the `admins.role` CHECK constraint)
SUPER_ADMIN_ROLE = 1


class CurrentAdmin(NamedTuple):
    """The authenticated admin for a request: their row's id and role. Lives
    here (not in api/dependencies.py, where it's re-exported for routers)
    specifically so services/case_service.py can depend on it without a
    services -> api layering violation."""

    id: str
    role: int


class AdminTokenPayload(TypedDict):
    admin_id: str
    role: int


class InvalidAdminToken(Exception):
    """Raised for any invalid, expired, tampered, or malformed admin session JWT."""


class GoogleTokenInvalid(Exception):
    """Raised when a Google ID token fails verification, or the account's
    Workspace domain doesn't match ``ADMIN_ALLOWED_DOMAIN``."""


def create_admin_jwt(admin_id: str, role: int) -> str:
    settings = get_settings()
    now = int(time.time())
    payload = {
        "admin_id": admin_id,
        "role": role,
        "iat": now,
        "exp": now + ADMIN_JWT_EXPIRY_SECONDS,
    }
    return jwt.encode(payload, settings.admin_jwt_secret, algorithm=ADMIN_JWT_ALGORITHM)


def decode_admin_jwt(token: str) -> AdminTokenPayload:
    settings = get_settings()
    try:
        payload = jwt.decode(
            token, settings.admin_jwt_secret, algorithms=[ADMIN_JWT_ALGORITHM]
        )
    except jwt.PyJWTError as exc:
        raise InvalidAdminToken(str(exc)) from exc

    admin_id = payload.get("admin_id")
    role = payload.get("role")
    if not admin_id or role not in _VALID_ROLES:
        raise InvalidAdminToken("Missing or invalid admin_id/role claim.")
    return {"admin_id": admin_id, "role": role}


def verify_google_id_token(id_token_str: str) -> dict:
    """Verify signature + audience via Google, then check the `hd` (hosted
    domain) claim against ``ADMIN_ALLOWED_DOMAIN``. Returns the decoded claims
    (at least ``email``, ``hd``, ``email_verified``) on success."""
    settings = get_settings()
    try:
        claims = google_id_token.verify_oauth2_token(
            id_token_str, google_requests.Request(), settings.google_client_id
        )
    except ValueError as exc:
        raise GoogleTokenInvalid(str(exc)) from exc

    if not claims.get("email_verified"):
        raise GoogleTokenInvalid("Google account email is not verified.")

    hd = claims.get("hd")
    if not settings.admin_allowed_domain or hd != settings.admin_allowed_domain:
        raise GoogleTokenInvalid("Google account is not on the allowed Workspace domain.")

    return claims
