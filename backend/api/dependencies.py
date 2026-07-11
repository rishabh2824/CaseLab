from fastapi import Depends, Header, HTTPException

from models.admin import AdminRole
from services import admin_repository
from services.admin_auth import CurrentAdmin, InvalidAdminToken, decode_admin_jwt
from services.db import get_db_client

__all__ = ["CurrentAdmin", "get_current_admin", "require_super_admin"]


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing admin credentials.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing admin credentials.")
    return token


async def get_current_admin(
    authorization: str | None = Header(default=None),
) -> CurrentAdmin:
    """Decode/verify the bearer session JWT, then re-fetch the admin row from
    ``admins`` by id on every request (cheap at ~20 admins). Re-fetching
    (rather than trusting the JWT's claims alone) means a deleted admin's
    still-unexpired token stops working immediately instead of lingering
    until it naturally expires.
    """
    token = _extract_bearer_token(authorization)
    try:
        payload = decode_admin_jwt(token)
    except InvalidAdminToken as exc:
        raise HTTPException(
            status_code=401, detail="Invalid or expired admin session."
        ) from exc

    client = get_db_client()
    admin = await admin_repository.get_by_id(client, payload["admin_id"])
    if admin is None:
        raise HTTPException(status_code=401, detail="Admin account no longer exists.")
    return CurrentAdmin(id=admin["id"], role=AdminRole(admin["role"]))


async def require_super_admin(
    admin: CurrentAdmin = Depends(get_current_admin),
) -> CurrentAdmin:
    if admin.role != AdminRole.SUPER:
        raise HTTPException(status_code=403, detail="Super admin access required.")
    return admin
