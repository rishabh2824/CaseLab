import os
import uuid
from fastapi import APIRouter
from models.uploads import PresignUploadRequest, PresignUploadResponse
from infra.spaces import putUrl
from infra.settings import get_settings


router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/presign", response_model=PresignUploadResponse)
def presign_upload(payload: PresignUploadRequest) -> PresignUploadResponse:
    settings = get_settings()

    _, ext = os.path.splitext(payload.file_name)
    extension = ext.lower()
    safe_prefix = payload.prefix.strip("/") if payload.prefix else ""
    key_base = f"{uuid.uuid4().hex}{extension}"
    object_key = f"{safe_prefix}/{key_base}" if safe_prefix else key_base

    upload_url = putUrl(object_key, payload.content_type)
    return PresignUploadResponse(
        upload_url=upload_url,
        bucket=settings.spaces_bucket,
        object_key=object_key,
        file_name=payload.file_name,
        content_type=payload.content_type,
        expires_in=settings.spaces_presign_expiry,
    )
