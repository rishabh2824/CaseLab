"""CRUD for the ``admins`` table.

Scale is ~20 admins total (see plan), so every function here does the
simplest possible query rather than anything batched/paginated.
"""

import uuid

from services.db import row_to_dict, rows_to_dicts

_SELECT_COLUMNS = "id, email, name, role"


async def get_by_email(client, email: str) -> dict | None:
    result = await client.execute(
        f"select {_SELECT_COLUMNS} from admins where email = ?",
        (email,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None


async def get_by_id(client, admin_id: str) -> dict | None:
    result = await client.execute(
        f"select {_SELECT_COLUMNS} from admins where id = ?",
        (admin_id,),
    )
    return row_to_dict(result.rows[0]) if result.rows else None


async def list_all(client) -> list[dict]:
    result = await client.execute(f"select {_SELECT_COLUMNS} from admins order by email")
    return rows_to_dicts(result.rows)


async def create(client, email: str, name: str | None, role: int) -> dict:
    admin_id = uuid.uuid4().hex
    await client.execute(
        "insert into admins (id, email, name, role) values (?, ?, ?, ?)",
        (admin_id, email, name, role),
    )
    return {"id": admin_id, "email": email, "name": name, "role": role}


async def delete(client, admin_id: str) -> None:
    await client.batch(
        [
            ("PRAGMA foreign_keys = ON", ()),
            ("delete from admins where id = ?", (admin_id,)),
        ]
    )
