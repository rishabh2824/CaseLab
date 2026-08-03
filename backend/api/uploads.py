from fastapi import APIRouter, Depends
from models.uploads import PresignUploadRequest, PresignUploadResponse
from services import uploads as upload_service
from .dependencies import getCurrentAdmin


router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/presign", response_model=PresignUploadResponse, dependencies=[Depends(getCurrentAdmin)])
def presignUpload(payload: PresignUploadRequest) -> PresignUploadResponse:
    return upload_service.presignUpload(payload.file_name, payload.content_type, payload.prefix)
