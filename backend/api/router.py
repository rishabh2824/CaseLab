from fastapi import APIRouter
from .admin import router as admin_router
from .cases import router as cases_router
from .simulations import router as simulations_router
from .uploads import router as uploads_router


api_router = APIRouter()
api_router.include_router(admin_router)
api_router.include_router(uploads_router)
api_router.include_router(cases_router)
api_router.include_router(simulations_router)
