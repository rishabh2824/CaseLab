from pydantic import BaseModel, Field


class UploadRequest(BaseModel):
    file_name: str = Field(..., min_length=1)
    content_type: str | None = None
    prefix: str | None = None


class UploadResponse(BaseModel):
    upload_url: str
    object_key: str
    file_name: str
    content_type: str | None = None
    expires_in: int


class UploadBatchRequest(BaseModel):
    files: list[UploadRequest] = Field(..., min_length=1)


class UploadBatchResponse(BaseModel):
    files: list[UploadResponse]
