from fastapi import APIRouter, Depends, Response
from sqlmodel.ext.asyncio.session import AsyncSession
from domain_errors import Unauthorized
from models.admin import AddAdminRequest, AdminDeletedResponse, AdminOut, AdminRole, LoginRequest, LoginResponse
from services import admin as admin_repository
from services.auth import clearCookie, createJwt, setCookie
from infra.db import getRequestSession
from .dependencies import CurrentAdmin, getCurrentAdmin, requireSuperAdmin


router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login", response_model=LoginResponse)
async def login(
    payload: LoginRequest, response: Response, session: AsyncSession = Depends(getRequestSession)
) -> LoginResponse:
    admin = await admin_repository.loginWithGoogleCredential(session, payload.credential)
    role = AdminRole(admin["role"])
    token = createJwt(admin["id"], role)
    setCookie(response, token)
    return LoginResponse(admin_id=admin["id"], role=role, email=admin["email"], name=admin["name"])


@router.post("/logout")
async def logout(response: Response) -> dict:
    clearCookie(response)
    return {"ok": True}


@router.get("/me", response_model=LoginResponse)
async def me(
    admin: CurrentAdmin = Depends(getCurrentAdmin), session: AsyncSession = Depends(getRequestSession)
) -> LoginResponse:
    record = await admin_repository.getById(session, admin.id)
    if record is None:
        raise Unauthorized("Admin account no longer exists.")
    return LoginResponse(admin_id=record["id"], role=AdminRole(record["role"]), email=record["email"], name=record["name"])


@router.get("/admins", response_model=list[AdminOut], dependencies=[Depends(getCurrentAdmin)])
async def listAdmins(session: AsyncSession = Depends(getRequestSession)) -> list[dict]:
    return await admin_repository.listAll(session)


@router.post("/admins", response_model=AdminOut, dependencies=[Depends(requireSuperAdmin)])
async def addAdmin(payload: AddAdminRequest, session: AsyncSession = Depends(getRequestSession)) -> dict:
    return await admin_repository.create(session, payload.email, payload.name, payload.role)


@router.delete("/admins/{admin_id}", response_model=AdminDeletedResponse, dependencies=[Depends(requireSuperAdmin)])
async def deleteAdmin(admin_id: int, session: AsyncSession = Depends(getRequestSession)) -> dict:
    return await admin_repository.deleteWithCascade(session, admin_id)
