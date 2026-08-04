from fastapi import APIRouter, Depends, Response
from sqlmodel.ext.asyncio.session import AsyncSession
from domain_errors import Unauthorized
from models.admin import AddAdminRequest, AdminDeletedResponse, AdminOut, LoginRequest, LoginResponse
from services import admin as admin_repository
from services.auth import clearCookie, createJwt, setCookie
from infra.db import getRequestSession
from .dependencies import CurrentAdmin, getCurrentAdmin, requireSuperAdmin


router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login")
async def login(
    payload: LoginRequest, response: Response, session: AsyncSession = Depends(getRequestSession)
) -> LoginResponse:
    admin = await admin_repository.loginWithGoogleCredential(session, payload.credential)
    token = createJwt(admin.id, admin.role)
    setCookie(response, token)
    return LoginResponse(admin_id=admin.id, role=admin.role, email=admin.email, name=admin.name)


@router.post("/logout")
async def logout(response: Response) -> dict:
    clearCookie(response)
    return {"ok": True}


@router.get("/me")
async def me(
    admin: CurrentAdmin = Depends(getCurrentAdmin), session: AsyncSession = Depends(getRequestSession)
) -> LoginResponse:
    record = await admin_repository.getById(session, admin.id)
    if record is None:
        raise Unauthorized("Admin account no longer exists.")
    return LoginResponse(admin_id=record.id, role=record.role, email=record.email, name=record.name)


@router.get("/admins", dependencies=[Depends(getCurrentAdmin)])
async def listAdmins(session: AsyncSession = Depends(getRequestSession)) -> list[AdminOut]:
    return await admin_repository.listAll(session)


@router.post("/admins", dependencies=[Depends(requireSuperAdmin)])
async def addAdmin(payload: AddAdminRequest, session: AsyncSession = Depends(getRequestSession)) -> AdminOut:
    return await admin_repository.create(session, payload.email, payload.name, payload.role)


@router.delete("/admins/{admin_id}", dependencies=[Depends(requireSuperAdmin)])
async def deleteAdmin(admin_id: int, session: AsyncSession = Depends(getRequestSession)) -> AdminDeletedResponse:
    return await admin_repository.deleteWithCascade(session, admin_id)
