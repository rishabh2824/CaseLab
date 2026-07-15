from fastapi import Cookie, Depends, HTTPException
from models.admin import AdminRole
from Queries import admin as admin_repository
from services.admin_auth import ADMIN_COOKIE_NAME, CurrentAdmin, InvalidAdminToken, decode_jwt
from infra.db import getDb


# Controls from api.dependencies import * — only these three names would come through.
__all__ = ["CurrentAdmin", "getCurrentAdmin", "requireSuperAdmin"]


async def getCurrentAdmin(
    admin_session: str | None = Cookie(default=None, alias=ADMIN_COOKIE_NAME),
) -> CurrentAdmin:
    if not admin_session: raise HTTPException(status_code=401, detail="Missing admin credentials.")
    try: payload = decode_jwt(admin_session)
    except InvalidAdminToken as exc: raise HTTPException(status_code=401, detail="Invalid admin session.") from exc

    client = getDb()
    admin = await admin_repository.getById(client, payload["admin_id"])
    if admin is None: raise HTTPException(status_code=401, detail="Admin account no longer exists.")
    return CurrentAdmin(id=admin["id"], role=AdminRole(admin["role"]))


async def requireSuperAdmin(admin: CurrentAdmin = Depends(getCurrentAdmin)) -> CurrentAdmin:
    if admin.role != AdminRole.SUPER: raise HTTPException(status_code=403, detail="Super admin access required.")
    return admin
