#Shared leaf-level helper used by both the cases (admin) and simulation (live) domains

from infra.spaces import getUrl


def photo_ref(row: dict, *, presign: bool) -> dict | None:
    if not (row["bucket"] and row["object_key"] and row["file_name"]): return None
    ref = {
        "bucket": row["bucket"],
        "object_key": row["object_key"],
        "file_name": row["file_name"],
        "content_type": row["content_type"],
    }
    if presign: ref["url"] = getUrl(row["object_key"])
    return ref
