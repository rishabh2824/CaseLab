import os
import uuid
from infra.settings import getSettings
from infra.spaces import putUrl
from models.uploads import PresignUploadResponse


# Path-traversal-safe: drops any "", "." or ".." segment so a caller-supplied
# prefix can never escape the bucket's intended folder.
def buildObjectKey(file_name: str, prefix: str | None) -> str:
    _, ext = os.path.splitext(file_name)
    extension = ext.lower()
    segments = prefix.split("/") if prefix else []
    safe_prefix = "/".join(segment for segment in segments if segment not in ("", ".", ".."))
    key_base = f"{uuid.uuid4().hex}{extension}"
    return f"{safe_prefix}/{key_base}" if safe_prefix else key_base


def presignUpload(file_name: str, content_type: str | None, prefix: str | None) -> PresignUploadResponse:
    settings = getSettings()
    object_key = buildObjectKey(file_name, prefix)
    upload_url = putUrl(object_key, content_type)
    return PresignUploadResponse(
        upload_url=upload_url,
        object_key=object_key,
        file_name=file_name,
        content_type=content_type,
        expires_in=settings.spaces_upload_expiry,
    )
