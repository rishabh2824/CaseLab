import os
import uuid
from fastapi import APIRouter
from models.uploads import PresignUploadRequest, PresignUploadResponse
from infra.spaces import putUrl
from infra.settings import getSettings


router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/presign", response_model=PresignUploadResponse)
def presignUpload(payload: PresignUploadRequest) -> PresignUploadResponse:
    settings = getSettings()

    _, ext = os.path.splitext(payload.file_name)
    extension = ext.lower()
    segments = payload.prefix.split("/") if payload.prefix else []
    safe_prefix = "/".join(s for s in segments if s not in ("", ".", ".."))
    key_base = f"{uuid.uuid4().hex}{extension}"
    object_key = f"{safe_prefix}/{key_base}" if safe_prefix else key_base

    upload_url = putUrl(object_key, payload.content_type)
    return PresignUploadResponse(
        upload_url=upload_url,
        object_key=object_key,
        file_name=payload.file_name,
        content_type=payload.content_type,
        expires_in=settings.spaces_upload_expiry,
    )
