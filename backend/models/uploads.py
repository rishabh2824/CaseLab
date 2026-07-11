from pydantic import BaseModel, Field


class PresignUploadRequest(BaseModel):
    file_name: str = Field(..., min_length=1)
    content_type: str | None = None
    prefix: str | None = None


class PresignUploadResponse(BaseModel):
    upload_url: str
    bucket: str
    object_key: str
    file_name: str
    content_type: str | None = None
    expires_in: int
