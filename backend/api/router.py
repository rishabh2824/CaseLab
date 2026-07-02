from fastapi import APIRouter, Depends

from .admin import router as admin_router
from .cases import router as cases_router
from .dependencies import require_admin
from .simulations import router as simulations_router
from .uploads import router as uploads_router

api_router = APIRouter()

# Public: lets an admin exchange their code for a confirmation (used by the
# home screen to route into the admin area).
api_router.include_router(admin_router)

# Admin-only: creating / reading / editing cases and minting upload URLs.
api_router.include_router(uploads_router, dependencies=[Depends(require_admin)])
api_router.include_router(cases_router, dependencies=[Depends(require_admin)])

# Public: the student simulation experience.
api_router.include_router(simulations_router)
