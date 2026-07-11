from enum import IntEnum

from pydantic import BaseModel, field_validator


class AdminRole(IntEnum):
    """The single source of truth for admin role values — import this
    everywhere a role is assigned or compared rather than writing 1/2
    directly, so the two never drift apart."""

    SUPER = 1
    ADMIN = 2


class GoogleLoginRequest(BaseModel):
    google_id_token: str


class LoginResponse(BaseModel):
    admin_jwt: str
    admin_id: str
    role: AdminRole
    email: str
    name: str | None = None


class AddAdminRequest(BaseModel):
    email: str
    name: str | None = None
    # Typing this as AdminRole (not int) makes Pydantic itself reject an
    # out-of-range role, so there's no separate validator to keep in sync.
    role: AdminRole

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if "@" not in value:
            raise ValueError("email must be a valid email address.")
        return value


class AdminOut(BaseModel):
    id: str
    email: str
    name: str | None = None
    role: AdminRole
