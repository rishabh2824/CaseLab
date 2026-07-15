import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from api.router import api_router
from infra.db import closeDb
from infra.llm import closeClient, initClient
from infra.rate_limit import cleanStaleLimits
from Queries.simulation.runs import (RunExpired, RunNotFound, RunWriteConflict, cleanup_expired_runs)
from infra.settings import get_settings


settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Shared httpx client for all LLM calls, so that the several requests from one student message reuses pooled
    # connections instead of a fresh TLS handshake.
    initClient()

    # Sweepers
    cleanup_task = asyncio.create_task(cleanup_expired_runs())
    rate_limit_cleanup = asyncio.create_task(cleanStaleLimits())
    try: yield
    finally:
        cleanup_task.cancel()
        rate_limit_cleanup.cancel()
        for task in (cleanup_task, rate_limit_cleanup):
            try: await task
            except asyncio.CancelledError: pass
        await closeClient()
        await closeDb()


app = FastAPI(title="caseLab API", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


if settings.frontendUrls:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.frontendUrls,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.exception_handler(RunNotFound)
async def run_not_found(request, exc: RunNotFound):
    return JSONResponse(status_code=404, content={"detail": "Simulation run not found."})


@app.exception_handler(RunExpired)
async def run_expired(request, exc: RunExpired):
    return JSONResponse(status_code=404, content={"detail": "Simulation run expired."})


@app.exception_handler(RunWriteConflict)
async def run_write_conflict(request, exc: RunWriteConflict):
    return JSONResponse(status_code=409, content={"detail": "This session is busy — please try again."})


app.include_router(api_router, prefix="/api")
