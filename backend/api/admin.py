from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.concurrency import run_in_threadpool
from models.admin import AddAdminRequest, AdminOut, AdminRole, LoginRequest, LoginResponse
from Queries import admin as admin_repository
from services.admin_auth import (
    GoogleTokenInvalid,
    clear_admin_cookie,
    create_jwt,
    exchange_auth_code,
    set_admin_cookie,
    verify_google_id_token,
)
from infra.db import getDb
from .dependencies import requireSuperAdmin


router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest, response: Response) -> LoginResponse:
    # Verify_google_id_token makes a synchronous network call to Google
    try:
        id_token_str = await exchange_auth_code(payload.google_auth_code)
        claims = await run_in_threadpool(verify_google_id_token, id_token_str)
    except GoogleTokenInvalid as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    client = getDb()
    admin = await admin_repository.getByEmail(client, claims["email"])
    if admin is None:
        raise HTTPException(status_code=401, detail="Your account is not authorized")

    role = AdminRole(admin["role"])
    token = create_jwt(admin["id"], role)
    set_admin_cookie(response, token)
    return LoginResponse(admin_id=admin["id"], role=role, email=admin["email"], name=admin["name"])


@router.post("/logout")
async def logout(response: Response) -> dict:
    clear_admin_cookie(response)
    return {"ok": True}


@router.get("/admins", response_model=list[AdminOut], dependencies=[Depends(requireSuperAdmin)])
async def listAdmins() -> list[dict]:
    client = getDb()
    return await admin_repository.listAll(client)


@router.post("/admins", response_model=AdminOut, dependencies=[Depends(requireSuperAdmin)])
async def addAdmin(payload: AddAdminRequest) -> dict:
    client = getDb()
    existing = await admin_repository.getByEmail(client, payload.email)
    if existing is not None: raise HTTPException(status_code=409, detail="An admin with this email already exists.")
    return await admin_repository.create(client, payload.email, payload.name, payload.role)


@router.delete("/admins/{admin_id}", dependencies=[Depends(requireSuperAdmin)])
async def deleteAdmin(admin_id: str) -> dict:
    client = getDb()
    existing = await admin_repository.getById(client, admin_id)
    if existing is None: raise HTTPException(status_code=404, detail="Admin not found.")
    if existing["role"] == AdminRole.SUPER: raise HTTPException(status_code=403, detail="Super admins cannot be deleted.")

    await admin_repository.delete(client, admin_id)
    return {"ok": True}
