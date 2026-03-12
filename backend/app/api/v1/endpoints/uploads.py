import os
import uuid

from fastapi import APIRouter, HTTPException

from app.core.settings import get_settings
from app.schemas.uploads import PresignUploadRequest, PresignUploadResponse
from app.services.spaces import create_presigned_put_url

router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/presign", response_model=PresignUploadResponse)
def presign_upload(payload: PresignUploadRequest) -> PresignUploadResponse:
    settings = get_settings()
    if not settings.spaces_key or not settings.spaces_secret or not settings.spaces_bucket:
        raise HTTPException(status_code=500, detail="Spaces credentials are not configured.")

    _, ext = os.path.splitext(payload.file_name)
    extension = ext.lower()
    safe_prefix = payload.prefix.strip("/") if payload.prefix else ""
    key_base = f"{uuid.uuid4().hex}{extension}"
    object_key = f"{safe_prefix}/{key_base}" if safe_prefix else key_base

    upload_url = create_presigned_put_url(object_key, payload.content_type)
    return PresignUploadResponse(
        upload_url=upload_url,
        bucket=settings.spaces_bucket,
        object_key=object_key,
        file_name=payload.file_name,
        content_type=payload.content_type,
        expires_in=settings.spaces_presign_expiry_seconds,
    )
