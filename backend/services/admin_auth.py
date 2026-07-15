from __future__ import annotations
import time
from typing import NamedTuple, TypedDict, Any, Mapping
import cachecontrol
import httpx
import jwt
import requests
from fastapi import Response
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from models.admin import AdminRole
from infra.settings import JWT_ALGORITHM, JWT_EXPIRY, get_settings


GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
ADMIN_COOKIE_NAME = "admin_session"

# A cache-backed session so Google's signing certs are fetched once and reused across logins
_google_request = google_requests.Request(session=cachecontrol.CacheControl(requests.Session()))


class CurrentAdmin(NamedTuple):
    id: str
    role: AdminRole


class AdminTokenPayload(TypedDict):
    admin_id: str
    role: AdminRole


# Raised for any invalid admin session JWT
class InvalidAdminToken(Exception):
    """."""


# Raised when the OAuth code exchange fails, a Google ID token fails verification
class GoogleTokenInvalid(Exception):
    """."""


def create_jwt(admin_id: str, role: AdminRole) -> str:
    settings = get_settings()
    now = int(time.time())
    payload = {"admin_id": admin_id, "role": role, "iat": now, "exp": now + JWT_EXPIRY}
    return jwt.encode(payload, settings.jwt_secret, algorithm=JWT_ALGORITHM)


def set_admin_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=ADMIN_COOKIE_NAME,
        value=token,
        max_age=JWT_EXPIRY,
        httponly=True,
        secure=settings.admin_cookie_secure,
        samesite=settings.adminCookie,
        path="/",
    )


def clear_admin_cookie(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(
        key=ADMIN_COOKIE_NAME,
        path="/",
        secure=settings.admin_cookie_secure,
        samesite=settings.adminCookie,
    )


def decode_jwt(token: str) -> AdminTokenPayload:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise InvalidAdminToken(str(exc)) from exc

    admin_id = payload.get("admin_id")
    role = payload.get("role")
    if not admin_id or role not in (AdminRole.SUPER, AdminRole.ADMIN):
        raise InvalidAdminToken("Missing or invalid admin_id/role claim.")
    return {"admin_id": admin_id, "role": AdminRole(role)}


# Exchange the authorization code from the frontend's ``initCodeClient({ux_mode: 'popup'})`` flow for a Google ID token.
async def exchange_auth_code(auth_code: str) -> str:
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        response = await client.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "code": auth_code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": "postmessage",
                "grant_type": "authorization_code",
            },
        )
    if response.status_code != 200:
        raise GoogleTokenInvalid(f"Google code exchange failed: {response.text}")

    id_token_str = response.json().get("id_token")
    if not id_token_str:
        raise GoogleTokenInvalid("Google code exchange did not return an ID token.")
    return id_token_str


def verify_google_id_token(id_token_str: str) -> Mapping[str, Any]:
    settings = get_settings()
    try:
        claims = google_id_token.verify_oauth2_token(
            id_token_str, _google_request, settings.google_client_id # type: ignore
        )
    except ValueError as exc:
        raise GoogleTokenInvalid(str(exc)) from exc

    if not claims.get("email_verified"):
        raise GoogleTokenInvalid("Google account email is not verified.")

    return claims
