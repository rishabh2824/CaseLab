from fastapi import APIRouter, Depends
from models.uploads import (
    UploadBatchRequest,
    UploadBatchResponse,
    PresignUpload,
    UploadResponse,
)
from services import uploads as upload_service
from .dependencies import getCurrentAdmin


router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/presign", dependencies=[Depends(getCurrentAdmin)])
def presignUpload(payload: PresignUpload) -> UploadResponse:
    return upload_service.presignUpload(payload.file_name, payload.content_type, payload.prefix)


# Lets a case save (many personas, each with a photo/attachments) presign every file in
# one authenticated request instead of one round trip per file — see
# services/uploads.py::presignUploadBatch.
@router.post("/presign/batch", dependencies=[Depends(getCurrentAdmin)])
def presignUploadBatchRoute(payload: UploadBatchRequest) -> UploadBatchResponse:
    return UploadBatchResponse(files=upload_service.presignUploadBatch(payload.files))
