from typing import Optional

from pydantic import BaseModel, field_validator

_VALID_ROLES = (1, 2)  # 1 = super admin, 2 = admin


class GoogleLoginRequest(BaseModel):
    google_id_token: str


class LoginResponse(BaseModel):
    admin_jwt: str
    admin_id: str
    role: int
    email: str
    name: Optional[str] = None


class AddAdminRequest(BaseModel):
    email: str
    name: Optional[str] = None
    role: int

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if "@" not in value:
            raise ValueError("email must be a valid email address.")
        return value

    @field_validator("role")
    @classmethod
    def _valid_role(cls, value: int) -> int:
        if value not in _VALID_ROLES:
            raise ValueError("role must be 1 (super admin) or 2 (admin).")
        return value


class AdminOut(BaseModel):
    id: str
    email: str
    name: Optional[str] = None
    role: int
