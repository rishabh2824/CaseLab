from __future__ import annotations
import time
from typing import NamedTuple, TypedDict, Any, Mapping
import cachecontrol
import jwt
import requests
from fastapi import Response
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from models.admin import AdminRole
from infra.settings import JWT_ALGORITHM, JWT_EXPIRY, get_settings


COOKIE_NAME = "admin_session"

# A cache-backed session so Google's signing certs are fetched once and reused across logins
google_request = google_requests.Request(session=cachecontrol.CacheControl(requests.Session()))


class CurrentAdmin(NamedTuple):
    id: int
    role: AdminRole


class AdminTokenPayload(TypedDict):
    admin_id: int
    role: AdminRole


def createJwt(admin_id: int, role: AdminRole) -> str:
    settings = get_settings()
    now = int(time.time())
    payload = {"admin_id": admin_id, "role": role, "iat": now, "exp": now + JWT_EXPIRY}
    return jwt.encode(payload, settings.jwt_secret, algorithm=JWT_ALGORITHM)


def setCookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=JWT_EXPIRY,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )


def clearCookie(response: Response) -> None:
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        secure=True,
        samesite="lax",
    )


def decodeJwt(token: str) -> AdminTokenPayload:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise ValueError(str(exc)) from exc

    admin_id = payload.get("admin_id")
    role = payload.get("role")
    if admin_id is None or role not in (AdminRole.SUPER, AdminRole.ADMIN):
        raise ValueError("Missing or invalid admin_id/role claim.")
    return {"admin_id": admin_id, "role": AdminRole(role)}


# Verifies the ID token from the frontend's google.accounts.id CredentialResponse
# (SignInButton.svelte) locally against Google's cached public signing keys — no
# outbound call to Google needed, unlike the old code-exchange flow this replaced.
def verifyToken(id_token_str: str) -> Mapping[str, Any]:
    settings = get_settings()
    claims = google_id_token.verify_oauth2_token(
        id_token_str, google_request, settings.google_client_id # type: ignore
    )
    if not claims.get("email_verified"):
        raise ValueError("Google account email is not verified.")

    return claims
