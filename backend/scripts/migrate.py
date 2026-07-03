"""Apply pending SQL migrations to the database.

Why this exists
----------------
There was previously no schema versioning: ``backend/schema.txt`` was a plain
SQL dump, applied by hand, with no record of what had or hadn't been run
against a given database. This is a minimal migration runner instead of a
full ORM/migration framework (see the decision in the project history) —
versioned ``.sql`` files in ``backend/migrations/``, tracked in a
``_schema_migrations`` table so each file runs at most once.

Adding a migration
-------------------
Create a new file in ``backend/migrations/`` named ``NNNN_description.sql``
(next number, zero-padded), containing one or more SQL statements separated
by ``;``. Prefer ``CREATE TABLE IF NOT EXISTS`` / additive changes; this
runner does not support rollback.

Usage
-----
Run from the ``backend/`` directory with the same ``.env`` the API uses::

    python -m scripts.migrate
"""

from __future__ import annotations

import sys
from pathlib import Path

from services.db import get_db_client

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def _split_statements(sql: str) -> list[str]:
    """Split a .sql file into individual statements on top-level semicolons.

    Good enough for this project's DDL (no semicolons inside string literals
    or comments); strips full-line ``--`` comments first.
    """
    lines = [
        line for line in sql.splitlines() if not line.strip().startswith("--")
    ]
    stripped = "\n".join(lines)
    return [stmt.strip() for stmt in stripped.split(";") if stmt.strip()]


async def _ensure_migrations_table(client) -> None:
    await client.execute(
        """
        CREATE TABLE IF NOT EXISTS _schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )


async def _applied_versions(client) -> set[str]:
    result = await client.execute("SELECT version FROM _schema_migrations")
    return {row["version"] for row in result.rows}


async def run() -> int:
    if not MIGRATIONS_DIR.is_dir():
        print(f"No migrations directory at {MIGRATIONS_DIR}", file=sys.stderr)
        return 1

    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not migration_files:
        print("No migration files found.")
        return 0

    client = get_db_client()
    await _ensure_migrations_table(client)
    applied = await _applied_versions(client)

    pending = [f for f in migration_files if f.name not in applied]
    if not pending:
        print(f"Up to date ({len(applied)} migration(s) already applied).")
        return 0

    for migration_file in pending:
        statements = _split_statements(migration_file.read_text(encoding="utf-8"))
        if not statements:
            continue
        print(f"Applying {migration_file.name} ({len(statements)} statement(s))...")
        await client.batch(statements)
        await client.execute(
            "INSERT INTO _schema_migrations (version) VALUES (?)",
            (migration_file.name,),
        )
        print(f"  done: {migration_file.name}")

    print(f"Applied {len(pending)} migration(s).")
    return 0


def main() -> int:
    import asyncio

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
