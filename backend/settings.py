from functools import lru_cache
from pathlib import Path
from typing import ClassVar

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ADMIN_JWT_EXPIRY_SECONDS = 24 * 60 * 60  # 24h
ADMIN_JWT_ALGORITHM = "HS256"
MAX_SIMULATION_DURATION_MINUTES = 120


class Settings(BaseSettings):
    """Typed env config, loaded once from backend/.env (see model_config)
    plus real environment variables (the latter wins on conflict).

    Required fields (no default) fail at import time — Settings() is built
    the moment get_settings() is first called, which happens at module import
    in main.py — instead of booting fine and 500ing on the first request that
    happened to need the missing var.
    """

    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parent / ".env",
        extra="ignore",
    )

    # Fixed in code (not env-configurable) so there's one place to change
    # models. ClassVar excludes these from env-var sourcing entirely — an
    # LLM_MODEL env var would otherwise silently shadow this.
    llm_model: ClassVar[str] = "anthropic/claude-sonnet-5"  # frontier model for the persona reply
    llm_classifier_model: ClassVar[str] = "anthropic/claude-haiku-4.5"  # cheap YES/NO judges

    spaces_key: str
    spaces_secret: str
    spaces_bucket: str
    spaces_region: str = "sfo3"
    # Derived from spaces_region if not set explicitly — see
    # _default_spaces_endpoint below.
    spaces_endpoint: str = ""
    spaces_presign_expiry_seconds: int = 900

    db_url: str
    db_token: str

    # Raw comma-separated string (not a `list[str]` field) so pydantic-
    # settings doesn't try to JSON-decode it as a complex type — see the
    # `frontend_urls` property below for the parsed form callers actually use.
    frontend_urls_raw: str = Field(default="", validation_alias="FRONTEND_URLS")

    google_client_id: str
    admin_allowed_domain: str
    admin_jwt_secret: str = Field(min_length=32)  # enforce the README's advice

    llm_key: str
    llm_base_url: str = "https://openrouter.ai/api/v1/chat/completions"

    # Terminal tracing of the student-message LLM pipeline (services/debug_log.py)
    # — off by default; no output/overhead unless explicitly enabled. Start the
    # server with CASELAB_DEBUG=1 set to turn it on.
    debug: bool = Field(default=False, validation_alias="CASELAB_DEBUG")

    @model_validator(mode="after")
    def _default_spaces_endpoint(self) -> "Settings":
        if not self.spaces_endpoint:
            self.spaces_endpoint = f"https://{self.spaces_region}.digitaloceanspaces.com"
        return self

    @property
    def frontend_urls(self) -> list[str]:
        return [url.strip() for url in self.frontend_urls_raw.split(",") if url.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
