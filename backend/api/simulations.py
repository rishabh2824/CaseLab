from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
from models.simulations import NotesPayload, SendMessagePayload, StartSimulationPayload
from services.simulation import service as sim


router = APIRouter(prefix="/simulations", tags=["simulations"])


@router.post("/start")
async def startSimulation(payload: StartSimulationPayload):
    return await sim.start_simulation(payload)


@router.get("/{run_id}")
async def getSimulationState(run_id: str):
    return await sim.get_simulation_state(run_id)


@router.get("/{run_id}/export")
async def exportSimulation(run_id: str):
    return await sim.export_simulation(run_id)


@router.put("/{run_id}/notes")
async def updateNotes(run_id: str, payload: NotesPayload):
    return await sim.update_notes(run_id, payload)


@router.post("/{run_id}/message")
async def sendMessage(run_id: str, payload: SendMessagePayload):
    prepared = await sim.prepare_message(run_id, payload)
    return EventSourceResponse(sim.stream_message(prepared))
