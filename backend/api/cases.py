from fastapi import APIRouter, Depends

from models.cases import CasePayload
from services import case_service as cases

from .dependencies import CurrentAdmin, get_current_admin

router = APIRouter(prefix="/cases", tags=["cases"])


@router.post("")
async def create_case(payload: CasePayload, admin: CurrentAdmin = Depends(get_current_admin)):
    return await cases.create_case(payload, admin)


@router.get("")
async def list_cases(admin: CurrentAdmin = Depends(get_current_admin)):
    return await cases.list_cases(admin)


@router.get("/{case_id}")
async def get_case(case_id: str, admin: CurrentAdmin = Depends(get_current_admin)):
    return await cases.get_case(case_id, admin)


@router.put("/{case_id}")
async def update_case(
    case_id: str, payload: CasePayload, admin: CurrentAdmin = Depends(get_current_admin)
):
    return await cases.update_case(case_id, payload, admin)


@router.delete("/{case_id}")
async def delete_case(case_id: str, admin: CurrentAdmin = Depends(get_current_admin)):
    return await cases.delete_case(case_id, admin)
