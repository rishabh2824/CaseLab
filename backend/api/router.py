from fastapi import APIRouter, Depends
from .admin import router as admin_router
from .cases import router as cases_router
from .dependencies import get_current_admin
from .simulations import router as simulations_router
from .uploads import router as uploads_router

api_router = APIRouter()

# Mostly public: POST /admin/login exchanges a Google ID token for our own
# session JWT. The admin-management sub-routes (/admin/admins...) that share
# this router are individually gated by require_super_admin (see api/admin.py).
api_router.include_router(admin_router)

# Admin-only: creating / reading / editing cases and minting upload URLs.
api_router.include_router(uploads_router, dependencies=[Depends(get_current_admin)])
api_router.include_router(cases_router, dependencies=[Depends(get_current_admin)])

# Public: the student simulation experience.
api_router.include_router(simulations_router)
