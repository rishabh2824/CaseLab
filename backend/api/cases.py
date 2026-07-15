from fastapi import APIRouter, Depends
from models.cases import CasePayload
from services import cases
from .dependencies import CurrentAdmin, getCurrentAdmin


router = APIRouter(prefix="/cases", tags=["cases"])


@router.post("")
async def createCase(payload: CasePayload, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.create_case(payload, admin)


@router.get("")
async def listCases(admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.list_cases(admin)


@router.get("/{case_id}")
async def getCase(case_id: str, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.get_case(case_id, admin)


@router.put("/{case_id}")
async def updateCase(case_id: str, payload: CasePayload, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.update_case(case_id, payload, admin)


@router.delete("/{case_id}")
async def deleteCase(case_id: str, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.delete_case(case_id, admin)
