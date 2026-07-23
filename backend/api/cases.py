from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession
from models.cases import (
    CaseCreatedResponse,
    CaseDeletedResponse,
    CaseDetailResponse,
    CaseListResponse,
    CasePayload,
    CaseUpdatePayload,
    CaseVersionResponse,
)
from services import cases
from infra.db import getRequestSession
from .dependencies import CurrentAdmin, getCurrentAdmin


router = APIRouter(prefix="/cases", tags=["cases"])


@router.post("", response_model=CaseCreatedResponse)
async def createCase(
    payload: CasePayload,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.createCase(session, payload, admin)


@router.get("", response_model=CaseListResponse)
async def listCases(
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.listCases(session, admin)


@router.get("/{case_id}", response_model=CaseDetailResponse)
async def getCase(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.getCase(session, case_id, admin)


@router.put("/{case_id}", response_model=CaseCreatedResponse)
async def updateCase(
    case_id: int,
    payload: CaseUpdatePayload,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.updateCase(session, case_id, payload, admin)


@router.get("/{case_id}/version", response_model=CaseVersionResponse)
async def getCaseVersion(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.getCaseVersion(session, case_id, admin)


@router.delete("/{case_id}", response_model=CaseDeletedResponse)
async def deleteCase(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
):
    return await cases.deleteCase(session, case_id, admin)
