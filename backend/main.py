from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.router import api_router
from settings import get_settings

settings = get_settings()
app = FastAPI(title="caseLab API")

if settings.frontend_urls:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.frontend_urls,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(api_router, prefix="/api/v1")
