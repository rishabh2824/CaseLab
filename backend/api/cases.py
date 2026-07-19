from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession
from models.cases import CasePayload
from services import cases
from infra.db import getRequestSession
from .dependencies import CurrentAdmin, getCurrentAdmin


router = APIRouter(prefix="/cases", tags=["cases"])


@router.post("")
async def createCase(
    payload: CasePayload,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.createCase(session, payload, admin)


@router.get("")
async def listCases(
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.listCases(session, admin)


@router.get("/{case_id}")
async def getCase(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.getCase(session, case_id, admin)


@router.put("/{case_id}")
async def updateCase(
    case_id: int,
    payload: CasePayload,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.updateCase(session, case_id, payload, admin)


@router.delete("/{case_id}")
async def deleteCase(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.deleteCase(session, case_id, admin)
