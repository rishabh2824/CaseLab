import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware
from sqlalchemy import text
from api.router import api_router
from api.simulations import describeMessageStream
from domain_errors import DomainError
from infra.db import closeDb, getSession
from infra.llm import closeClient, initClient
from infra.rate_limit_policy import cleanStaleLimits
from services.simulation.run_store import cleanupRuns
from infra.settings import getSettings


settings = getSettings()


# Shared httpx client for all LLM calls, so that the several requests from one student message reuses pooled instead
# of a fresh TLS handshake.
@asynccontextmanager
async def lifespan(app: FastAPI):
    initClient()

    # Basically a cold start to the db to reduce latency of the first real request.
    try:
        async with getSession() as session:
            await session.exec(text("SELECT 1"))
    except Exception:
        pass

    # Sweepers
    cleanupTask = asyncio.create_task(cleanupRuns())
    rateLimitCleanup = asyncio.create_task(cleanStaleLimits())
    try: yield
    finally:
        cleanupTask.cancel()
        rateLimitCleanup.cancel()
        for task in (cleanupTask, rateLimitCleanup):
            try: await task
            except asyncio.CancelledError: pass
        await closeClient()
        await closeDb()


app = FastAPI(
    title="caseLab API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    # Turns off openapi schema (app related info) in prod, and keeps it on in dev for debugging.
    openapi_url="/openapi.json" if settings.enable_openapi else None
)


if settings.frontendUrls:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.frontendUrls,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Compress to reduce data transmitted over the network in API responses.
app.add_middleware(GZipMiddleware)


# Single mapping from a domain exception to an HTTP response
@app.exception_handler(DomainError)
async def domainErrorHandler(request: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)


app.include_router(api_router, prefix="/api")


# hand-registers SSE frame shapes into the generated schema so `pnpm gen:api` (frontend) picks them up like
# other endpoints.
def customOpenapi() -> dict:
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
    describeMessageStream(schema)
    app.openapi_schema = schema
    return app.openapi_schema
app.openapi = customOpenapi
