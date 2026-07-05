import hmac
from fastapi import Header, HTTPException
from settings import get_settings


async def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    """Reject any request that does not carry the valid shared admin token.
    The token is entered on the home screen and sent as the ``X-Admin-Token``
    header on admin/write requests. Compared in constant time so a wrong token
    cannot be discovered by timing the response.
    """
    expected = get_settings().admin_token
    if not expected:
        raise HTTPException(status_code=503, detail="Admin authentication is not configured.")
    if not hmac.compare_digest((x_admin_token or "").lower(), expected.lower()):
        raise HTTPException(status_code=401, detail="Invalid or missing admin credentials.")
