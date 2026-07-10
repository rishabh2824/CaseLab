"""Shared leaf-level helpers used by both the cases (admin) and simulation
(live) domains, which are otherwise deliberately independent of each other.

Kept intentionally small — one DB read and one pure shaping function, nothing
that orchestrates domain logic:

- ``fetch_root_personas`` — the "which personas in this case does nothing
  refer to" query, character-for-character identical in both domains (the
  case editor's initial roster and the simulation's initially-available
  contacts are the same set of rows).
- ``photo_ref`` — shapes a joined bucket/object_key/file_name/content_type
  row (possibly all NULL, from a LEFT JOIN) into the dict the frontend
  expects, or None. Used for a persona's own profile photo AND for a shared
  file's underlying file reference — both are the same optional 4-key dict.
"""

from services.db import rows_to_dicts
from services.spaces import create_presigned_get_url


def photo_ref(row: dict, *, presign: bool) -> dict | None:
    """`presign=True` adds a live download `url` (the simulation domain,
    shown to students); `presign=False` omits it (the case editor only needs
    the metadata, not a link that will expire before anyone clicks it)."""
    if not (row["bucket"] and row["object_key"] and row["file_name"]):
        return None
    ref = {
        "bucket": row["bucket"],
        "object_key": row["object_key"],
        "file_name": row["file_name"],
        "content_type": row["content_type"],
    }
    if presign:
        ref["url"] = create_presigned_get_url(row["object_key"])
    return ref


async def fetch_root_personas(client, case_id: str) -> list[dict]:
    result = await client.execute(
        """
        select p.id,
               p.name,
               p.role,
               photo.bucket,
               photo.object_key,
               photo.file_name,
               photo.content_type,
               p.scheduled_time,
               p.availability_duration
        from personas p
        left join files photo on photo.id = p.profile_photo_file_id
        where p.case_id = ?
          and p.id not in (
            select referred_persona_id
            from persona_referrals
            where case_id = ?
          )
        order by p.name
        """,
        (case_id, case_id),
    )
    return rows_to_dicts(result.rows)
