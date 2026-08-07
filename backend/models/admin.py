from enum import IntEnum
from pydantic import BaseModel


class AdminRole(IntEnum):
    SUPER = 1
    ADMIN = 2


class LoginRequest(BaseModel):
    credential: str


class LoginResponse(BaseModel):
    admin_id: int
    role: AdminRole
    email: str
    name: str | None = None


class AddAdmin(BaseModel):
    email: str
    name: str | None = None
    role: AdminRole


class AdminOut(BaseModel):
    id: int
    email: str
    name: str | None = None
    role: AdminRole


class DeleteAdmin(BaseModel):
    ok: bool
    cases_deleted: int
    cases_reassigned: int
