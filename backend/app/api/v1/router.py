from fastapi import APIRouter

from app.api.v1.endpoints.cases import router as cases_router
from app.api.v1.endpoints.uploads import router as uploads_router
from app.api.v1.endpoints.simulations import router as simulations_router

api_router = APIRouter()

api_router.include_router(uploads_router)
api_router.include_router(cases_router)
api_router.include_router(simulations_router)
