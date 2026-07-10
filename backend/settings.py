import os
from pathlib import Path

from dotenv import load_dotenv
from functools import lru_cache

# Fixed in code (not env-configurable) so there's one place to change models.
LLM_MODEL = "anthropic/claude-sonnet-5"  # frontier model for the persona reply
LLM_CLASSIFIER_MODEL = "anthropic/claude-haiku-4.5"  # cheap model for YES/NO judges + intros

# Admin session JWTs are short-lived (see api/dependencies.py /
# services/admin_auth.py): a deleted admin's token stops working the moment
# their row is gone (we re-check the admins table on every request), so this
# expiry is just a cap on how long a *still-valid* admin stays signed in.
ADMIN_JWT_EXPIRY_SECONDS = 24 * 60 * 60  # 24h
ADMIN_JWT_ALGORITHM = "HS256"

# Upper bound on a case's configurable simulation_duration, enforced when a
# case is created/updated (models/cases.py). services/simulation/state.py's
# RUN_TTL_SECONDS is derived from this + a grace period, so the two clocks
# can't disagree (a run's hard TTL can no longer expire before a case's own,
# shorter-or-equal, configured duration is up).
MAX_SIMULATION_DURATION_MINUTES = 120


class Settings:
    def __init__(self) -> None:
        base_dir = Path(__file__).resolve().parent
        load_dotenv(base_dir / ".env")
        self.spaces_key = os.getenv("SPACES_KEY", "")
        self.spaces_secret = os.getenv("SPACES_SECRET", "")
        self.spaces_bucket = os.getenv("SPACES_BUCKET", "")
        self.spaces_region = os.getenv("SPACES_REGION", "sfo3")
        self.spaces_endpoint = os.getenv(
            "SPACES_ENDPOINT",
            f"https://{self.spaces_region}.digitaloceanspaces.com",
        )
        self.spaces_presign_expiry_seconds = int(
            os.getenv("SPACES_PRESIGN_EXPIRY_SECONDS", "900"),
        )
        self.db_url = os.getenv("DB_URL", "")
        self.db_token = os.getenv("DB_TOKEN", "")
        raw_frontend_urls = os.getenv("FRONTEND_URLS", "")
        self.frontend_urls = [
            url.strip()
            for url in raw_frontend_urls.split(",")
            if url.strip()
        ]
        self.google_client_id = os.getenv("GOOGLE_CLIENT_ID", "")
        self.admin_allowed_domain = os.getenv("ADMIN_ALLOWED_DOMAIN", "")
        self.admin_jwt_secret = os.getenv("ADMIN_JWT_SECRET", "")
        self.llm_key = os.getenv("LLM_KEY", "")
        self.llm_model = LLM_MODEL
        self.llm_classifier_model = LLM_CLASSIFIER_MODEL
        self.llm_base_url = os.getenv(
            "LLM_BASE_URL",
            "https://openrouter.ai/api/v1/chat/completions",
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
