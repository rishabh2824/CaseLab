from enum import IntEnum
from pydantic import BaseModel


class AdminRole(IntEnum):
    SUPER = 1
    ADMIN = 2


class LoginRequest(BaseModel):
    # The ID token JWT from google.accounts.id's CredentialResponse
    # (SignInButton.svelte) — verified locally via services.auth.verifyToken,
    # no server-side call to Google needed.
    credential: str


class LoginResponse(BaseModel):
    admin_id: int
    role: AdminRole
    email: str
    name: str | None = None


class AddAdminRequest(BaseModel):
    email: str
    name: str | None = None
    role: AdminRole


class AdminOut(BaseModel):
    id: int
    email: str
    name: str | None = None
    role: AdminRole


# DELETE /admin/admins/{id} — deleteWithCascade's per-case delete-or-reassign
# counts, surfaced so the frontend can summarize the cascade in a toast.
class AdminDeletedResponse(BaseModel):
    ok: bool
    cases_deleted: int
    cases_reassigned: int
