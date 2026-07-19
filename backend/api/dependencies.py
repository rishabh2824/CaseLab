from fastapi import Cookie, Depends, HTTPException
from sqlmodel.ext.asyncio.session import AsyncSession
from models.admin import AdminRole
from services import admin as admin_repository
from services.auth import COOKIE_NAME, CurrentAdmin, decodeJwt
from infra.db import getRequestSession


# Separate from admin.py because it is also used by cases.py
# Controls from api.dependencies import * — only these three names would come through.
__all__ = ["CurrentAdmin", "getCurrentAdmin", "requireSuperAdmin"]


async def getCurrentAdmin(
    admin_session: str | None = Cookie(default=None, alias=COOKIE_NAME),
    session: AsyncSession = Depends(getRequestSession),
) -> CurrentAdmin:
    if not admin_session: raise HTTPException(status_code=401, detail="Missing admin credentials.")
    try: payload = decodeJwt(admin_session)
    except ValueError as exc: raise HTTPException(status_code=401, detail="Invalid admin session.") from exc

    admin = await admin_repository.getById(session, payload["admin_id"])
    if admin is None: raise HTTPException(status_code=401, detail="Admin account no longer exists.")
    return CurrentAdmin(id=admin["id"], role=AdminRole(admin["role"]))


async def requireSuperAdmin(admin: CurrentAdmin = Depends(getCurrentAdmin)) -> CurrentAdmin:
    if admin.role != AdminRole.SUPER: raise HTTPException(status_code=403, detail="Super admin access required.")
    return admin
