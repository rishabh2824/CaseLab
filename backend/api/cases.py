from fastapi import APIRouter

from models.cases import CasePayload
from services import case_service as cases

router = APIRouter(prefix="/cases", tags=["cases"])


@router.post("")
async def create_case(payload: CasePayload):
    return await cases.create_case(payload)


@router.get("")
async def list_cases():
    return await cases.list_cases()


@router.get("/active")
async def get_active_case():
    return await cases.get_active_case()


@router.get("/{case_id}")
async def get_case(case_id: str):
    return await cases.get_case(case_id)


@router.put("/{case_id}")
async def update_case(case_id: str, payload: CasePayload):
    return await cases.update_case(case_id, payload)
