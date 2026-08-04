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


@router.post("")
async def createCase(
    payload: CasePayload,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
) -> CaseCreatedResponse:
    return await cases.createCase(session, payload, admin)


@router.get("")
async def listCases(
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
) -> CaseListResponse:
    return await cases.listCases(session, admin)


@router.get("/demo", dependencies=[Depends(getCurrentAdmin)], response_model_exclude_none=True)
async def getDemoCase(
    session: AsyncSession = Depends(getRequestSession),
) -> CaseDetailResponse:
    return await cases.getDemoCase(session)


@router.get("/{case_id}")
async def getCase(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
) -> CaseDetailResponse:
    return await cases.getCase(session, case_id, admin)


@router.put("/{case_id}")
async def updateCase(
    case_id: int,
    payload: CaseUpdatePayload,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
) -> CaseCreatedResponse:
    return await cases.updateCase(session, case_id, payload, admin)


@router.get("/{case_id}/version")
async def getCaseVersion(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
) -> CaseVersionResponse:
    return await cases.getCaseVersion(session, case_id, admin)


@router.delete("/{case_id}")
async def deleteCase(
    case_id: int,
    admin: CurrentAdmin = Depends(getCurrentAdmin),
    session: AsyncSession = Depends(getRequestSession),
) -> CaseDeletedResponse:
    return await cases.deleteCase(session, case_id, admin)
