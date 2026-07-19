from fastapi import APIRouter, Depends
from models.cases import CasePayload
from services import cases
from .dependencies import CurrentAdmin, getCurrentAdmin


router = APIRouter(prefix="/cases", tags=["cases"])


@router.post("")
async def createCase(payload: CasePayload, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.createCase(payload, admin)


@router.get("")
async def listCases(admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.listCases(admin)


@router.get("/{case_id}")
async def getCase(case_id: int, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.getCase(case_id, admin)


@router.put("/{case_id}")
async def updateCase(case_id: int, payload: CasePayload, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.updateCase(case_id, payload, admin)


@router.delete("/{case_id}")
async def deleteCase(case_id: int, admin: CurrentAdmin = Depends(getCurrentAdmin)):
    return await cases.deleteCase(case_id, admin)
