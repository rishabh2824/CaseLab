from fastapi import APIRouter, Depends
from .admin import router as admin_router
from .cases import router as cases_router
from .dependencies import getCurrentAdmin
from .simulations import router as simulations_router
from .uploads import router as uploads_router


api_router = APIRouter()
api_router.include_router(admin_router)
api_router.include_router(uploads_router, dependencies=[Depends(getCurrentAdmin)])
api_router.include_router(cases_router, dependencies=[Depends(getCurrentAdmin)])
api_router.include_router(simulations_router)
