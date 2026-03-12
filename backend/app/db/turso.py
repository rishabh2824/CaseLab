from functools import lru_cache

import libsql_client

from app.core.settings import get_settings


@lru_cache(maxsize=1)
def get_db_client():
    settings = get_settings()
    if not settings.db_url or not settings.db_token:
        raise RuntimeError("DB_URL/DB_TOKEN are not configured.")
    url = settings.db_url
    if url.startswith("libsql://"):
        url = "https://" + url[len("libsql://") :]
    return libsql_client.create_client(url, auth_token=settings.db_token)
