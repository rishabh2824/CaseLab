import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Support both `backend.main:app` from the repo root and `main:app` from the
# backend directory in deployment environments like DigitalOcean App Platform.
current_dir = Path(__file__).resolve().parent
project_root = current_dir.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from backend.api.router import api_router
from backend.settings import get_settings

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
