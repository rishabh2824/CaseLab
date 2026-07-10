from fastapi import APIRouter, Depends, HTTPException

from models.admin import AddAdminRequest, AdminOut, GoogleLoginRequest, LoginResponse
from services import admin_repository
from services.admin_auth import GoogleTokenInvalid, create_admin_jwt, verify_google_id_token
from services.db import get_db_client

from .dependencies import require_super_admin

router = APIRouter(prefix="/admin", tags=["admin"])


# Public: exchanges a Google ID token for our own session JWT. This is the
# entire "sign in" flow — an admin's row already existing in `admins` (added
# by a super admin via POST /admins below) *is* their access grant; there is
# no separate invite/accept step.
@router.post("/login", response_model=LoginResponse)
async def login(payload: GoogleLoginRequest) -> LoginResponse:
    try:
        claims = verify_google_id_token(payload.google_id_token)
    except GoogleTokenInvalid as exc:
        raise HTTPException(status_code=401, detail="Google sign-in failed.") from exc

    client = get_db_client()
    admin = await admin_repository.get_by_email(client, claims["email"])
    if admin is None:
        raise HTTPException(
            status_code=401,
            detail="Your account is not authorized. Ask a super admin to add you.",
        )

    token = create_admin_jwt(admin["id"], admin["role"])
    return LoginResponse(
        admin_jwt=token,
        admin_id=admin["id"],
        role=admin["role"],
        email=admin["email"],
        name=admin["name"],
    )


# Super-admin only: the admin-management API backing frontend/src/pages/admin/Admins.jsx.


@router.get("/admins", response_model=list[AdminOut], dependencies=[Depends(require_super_admin)])
async def list_admins() -> list[dict]:
    client = get_db_client()
    return await admin_repository.list_all(client)


@router.post("/admins", response_model=AdminOut, dependencies=[Depends(require_super_admin)])
async def add_admin(payload: AddAdminRequest) -> dict:
    client = get_db_client()
    existing = await admin_repository.get_by_email(client, payload.email)
    if existing is not None:
        raise HTTPException(status_code=409, detail="An admin with this email already exists.")
    return await admin_repository.create(client, payload.email, payload.name, payload.role)


@router.delete("/admins/{admin_id}", dependencies=[Depends(require_super_admin)])
async def delete_admin(admin_id: str) -> dict:
    client = get_db_client()
    existing = await admin_repository.get_by_id(client, admin_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Admin not found.")
    # Cascade: deleting the row removes their cases too (cases.owner_admin_id
    # ... ON DELETE CASCADE) — see admin_repository.delete for why the PRAGMA
    # has to be batched with the DELETE for that to actually take effect.
    await admin_repository.delete(client, admin_id)
    return {"ok": True}
