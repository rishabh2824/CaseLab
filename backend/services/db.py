from functools import lru_cache

import libsql_client

from settings import get_settings


@lru_cache(maxsize=1)
def get_db_client():
    settings = get_settings()
    if not settings.db_url or not settings.db_token:
        raise RuntimeError("DB_URL/DB_TOKEN are not configured.")
    url = settings.db_url
    if url.startswith("libsql://"):
        url = "https://" + url[len("libsql://") :]
    return libsql_client.create_client(url, auth_token=settings.db_token)


async def close_db_client() -> None:
    """Close the cached client on app shutdown, if one was ever created."""
    if get_db_client.cache_info().currsize > 0:
        await get_db_client().close()
        get_db_client.cache_clear()


def row_to_dict(row: libsql_client.Row | None) -> dict | None:
    """Convert a single Row to a plain dict keyed by column name, or None."""
    return row.asdict() if row is not None else None


def rows_to_dicts(rows) -> list[dict]:
    """Convert a ResultSet/list of Rows to a list of plain dicts.

    Repositories return dicts (not positional tuples) so callers read
    ``row["column_name"]`` instead of relying on select-column order.
    """
    return [row.asdict() for row in rows]
