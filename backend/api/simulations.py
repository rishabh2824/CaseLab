from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from models.simulations import SendMessagePayload, StartSimulationPayload
from services.simulation import service as sim

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
    # Validate + resolve decisions up front: any client error is raised here as
    # a normal HTTP error, before the stream opens. The reply then streams as
    # Server-Sent Events (metadata first, then reply text). EventSourceResponse
    # sets the SSE headers (text/event-stream, no-cache, X-Accel-Buffering: no).
    prepared = await sim.prepare_message(run_id, payload)
    return EventSourceResponse(sim.stream_message(prepared))
