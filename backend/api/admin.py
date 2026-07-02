from fastapi import APIRouter, Depends

from .dependencies import require_admin

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/verify", dependencies=[Depends(require_admin)])
async def verify_admin():
    """Return 200 when the supplied ``X-Admin-Token`` is valid, else 401.

    The home screen calls this to decide whether a typed code is the admin
    code (and therefore whether to open the admin area).
    """
    return {"ok": True}
