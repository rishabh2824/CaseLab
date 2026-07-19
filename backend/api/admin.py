from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.concurrency import run_in_threadpool
from sqlmodel.ext.asyncio.session import AsyncSession
from models.admin import AddAdminRequest, AdminOut, AdminRole, LoginRequest, LoginResponse
from services import admin as admin_repository
from services.auth import (
    clearCookie,
    createJwt,
    exchangeCode,
    setCookie,
    verifyToken,
)
from infra.db import get_session, getRequestSession
from .dependencies import requireSuperAdmin


router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest, response: Response) -> LoginResponse:
    try:
        id_token_str = await exchangeCode(payload.google_auth_code)
        claims = await run_in_threadpool(verifyToken, id_token_str)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    async with get_session() as session:
        admin = await admin_repository.getByEmail(session, claims["email"])
    if admin is None:
        raise HTTPException(status_code=401, detail="Your account is not authorized")

    role = AdminRole(admin["role"])
    token = createJwt(admin["id"], role)
    setCookie(response, token)
    return LoginResponse(admin_id=admin["id"], role=role, email=admin["email"], name=admin["name"])


@router.post("/logout")
async def logout(response: Response) -> dict:
    clearCookie(response)
    return {"ok": True}


@router.get("/admins", response_model=list[AdminOut], dependencies=[Depends(requireSuperAdmin)])
async def listAdmins(session: AsyncSession = Depends(getRequestSession)) -> list[dict]:
    return await admin_repository.listAll(session)


@router.post("/admins", response_model=AdminOut, dependencies=[Depends(requireSuperAdmin)])
async def addAdmin(payload: AddAdminRequest, session: AsyncSession = Depends(getRequestSession)) -> dict:
    existing = await admin_repository.getByEmail(session, payload.email)
    if existing is not None: raise HTTPException(status_code=409, detail="An admin with this email already exists.")
    return await admin_repository.create(session, payload.email, payload.name, payload.role)


@router.delete("/admins/{admin_id}", dependencies=[Depends(requireSuperAdmin)])
async def deleteAdmin(admin_id: int, session: AsyncSession = Depends(getRequestSession)) -> dict:
    existing = await admin_repository.getById(session, admin_id)
    if existing is None: raise HTTPException(status_code=404, detail="Admin not found.")
    if existing["role"] == AdminRole.SUPER: raise HTTPException(status_code=403, detail="Super admins cannot be deleted.")

    await admin_repository.delete(session, admin_id)
    return {"ok": True}
