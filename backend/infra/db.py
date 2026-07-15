from functools import lru_cache
import libsql_client
from infra.settings import get_settings


@lru_cache(maxsize=1)
def getDb():
    settings = get_settings()
    url = settings.db_url
    if url.startswith("libsql://"): url = "https://" + url[len("libsql://") :]
    return libsql_client.create_client(url, auth_token=settings.db_token)


async def closeDb() -> None:
    if getDb.cache_info().currsize > 0:
        await getDb().close()
        getDb.cache_clear()


def rowToDict(row: libsql_client.Row | None) -> dict | None:
    return row.asdict() if row is not None else None


def rowsToDicts(rows) -> list[dict]:
    return [row.asdict() for row in rows]
