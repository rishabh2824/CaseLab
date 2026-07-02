from fastapi import APIRouter

from models.simulations import SendMessagePayload, StartSimulationPayload
from services import simulation_service as sim

router = APIRouter(prefix="/simulations", tags=["simulations"])


@router.post("/start")
async def start_simulation(payload: StartSimulationPayload):
    return await sim.start_simulation(payload)


@router.get("/{run_id}")
async def get_simulation_state(run_id: str):
    return await sim.get_simulation_state(run_id)


@router.get("/{run_id}/export")
async def export_simulation_history(run_id: str):
    return await sim.export_simulation_history(run_id)


@router.post("/{run_id}/message")
async def send_message(run_id: str, payload: SendMessagePayload):
    return await sim.handle_message(run_id, payload)
