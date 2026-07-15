import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sse_starlette.sse import EventSourceResponse
from Queries.simulation.runs import RunExpired, RunNotFound
from infra.settings import get_settings
from models.simulations import NotesPayload, SendMessagePayload, StartSimulationPayload
from services.simulation import service as sim


router = APIRouter(prefix="/simulations", tags=["simulations"])

# How often each connected socket re-reads its run's state from the DB. Correctness
# under autoscaling comes from every instance independently re-checking the same
# shared Turso row, not from instances coordinating with each other — so this works
# unmodified regardless of how many backend instances are running.
STATE_POLL_INTERVAL_SECONDS = 2.0


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


# Detects the client closing the socket. The client never sends anything meaningful on
# this connection (it's push-only), so this coroutine simply blocks on receive_text()
# until it either raises WebSocketDisconnect or the task is cancelled by the caller.
async def _wait_for_disconnect(websocket: WebSocket) -> None:
    while True:
        await websocket.receive_text()


@router.websocket("/{run_id}/live")
async def simulationLive(websocket: WebSocket, run_id: str):
    settings = get_settings()
    origin = websocket.headers.get("origin")
    if settings.frontendUrls and origin not in settings.frontendUrls:
        await websocket.close(code=4403)
        return

    await websocket.accept()
    disconnect_task = asyncio.create_task(_wait_for_disconnect(websocket))
    last_state = None
    try:
        while True:
            try:
                state = await sim.get_simulation_state(run_id)
            except (RunNotFound, RunExpired):
                await websocket.send_json({"type": "expired"})
                break
            if state != last_state:
                await websocket.send_json({"type": "state", "data": state})
                last_state = state
            done, _pending = await asyncio.wait(
                {disconnect_task}, timeout=STATE_POLL_INTERVAL_SECONDS
            )
            if disconnect_task in done:
                break
    except WebSocketDisconnect:
        pass
    finally:
        disconnect_task.cancel()
        try:
            await disconnect_task
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
