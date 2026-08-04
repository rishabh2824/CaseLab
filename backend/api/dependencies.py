from fastapi import Cookie, Depends
from sqlmodel.ext.asyncio.session import AsyncSession
from domain_errors import AccessDenied, Unauthorized
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
    if not admin_session:
        raise Unauthorized("Missing admin credentials.")
    try:
        payload = decodeJwt(admin_session)
    except ValueError as exc:
        raise Unauthorized("Invalid admin session.") from exc

    admin = await admin_repository.getById(session, payload["admin_id"])
    if admin is None:
        raise Unauthorized("Admin account no longer exists.")
    return CurrentAdmin(id=admin.id, role=admin.role)


async def requireSuperAdmin(admin: CurrentAdmin = Depends(getCurrentAdmin)) -> CurrentAdmin:
    if admin.role != AdminRole.SUPER:
        raise AccessDenied("Super admin access required.")
    return admin
