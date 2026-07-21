from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse
from models.simulations import (
    ExportResponse,
    NotesPayload,
    NotesResponse,
    RunStateResponse,
    SendMessagePayload,
    StartSimulationPayload,
)
from services.simulation import service as sim


router = APIRouter(prefix="/simulations", tags=["simulations"])


@router.post("/start", response_model=RunStateResponse)
async def startSimulation(payload: StartSimulationPayload):
    return await sim.startSimulation(payload)


@router.get("/{run_id}", response_model=RunStateResponse)
async def getSimulationState(run_id: str):
    try: return await sim.getSimulationState(run_id)
    except ValueError as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{run_id}/export", response_model=ExportResponse)
async def exportSimulation(run_id: str):
    try: return await sim.exportSimulation(run_id)
    except ValueError as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/{run_id}/notes", response_model=NotesResponse)
async def updateNotes(run_id: str, payload: NotesPayload):
    try: return await sim.updateNotes(run_id, payload)
    except ValueError as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{run_id}/message")
async def sendMessage(run_id: str, payload: SendMessagePayload):
    try: prepared = await sim.message(run_id, payload)
    except ValueError as exc: raise HTTPException(status_code=404, detail=str(exc)) from exc
    return EventSourceResponse(sim.streamMessage(prepared))