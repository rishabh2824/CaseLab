from functools import lru_cache
from pathlib import Path
from typing import ClassVar
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

JWT_EXPIRY = 24 * 60 * 60  # 24h
JWT_ALGORITHM = "HS256"
SIMULATION_DURATION = 120


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parent.parent / ".env", extra="ignore")

    llm_model: ClassVar[str] = "anthropic/claude-sonnet-5"
    llm_classifier_model: ClassVar[str] = "anthropic/claude-haiku-4.5"
    spaces_key: str
    spaces_secret: str
    spaces_upload_expiry: int = 900
    spaces_download_expiry: int = (SIMULATION_DURATION + 30) * 60
    pooling_url: str = Field(default="", validation_alias="POOLING")
    direct_url: str = Field(default="", validation_alias="DIRECT")
    frontend_urls_raw: str = Field(default="", validation_alias="FRONTEND_URLS")
    google_client_id: str
    jwt_secret: str = Field(min_length=32)
    llm_key: str
    llm_base_url: str = "https://openrouter.ai/api/v1"
    # Off by default (production doesn't publish its schema); set ENABLE_OPENAPI=true
    # in a local .env to serve /openapi.json for frontend codegen (see frontend/package.json's gen:api).
    enable_openapi: bool = Field(default=False, validation_alias="ENABLE_OPENAPI")

    @property
    def frontendUrls(self) -> list[str]:
        return [url.strip() for url in self.frontend_urls_raw.split(",") if url.strip()]


@lru_cache(maxsize=1)
def getSettings() -> Settings: return Settings()
