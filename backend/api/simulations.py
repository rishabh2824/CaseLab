import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sse_starlette.sse import EventSourceResponse
from Queries.simulation.runs import RunExpired, RunNotFound
from infra.pubsub import subscribe_run_updates
from infra.settings import get_settings
from models.simulations import NotesPayload, SendMessagePayload, StartSimulationPayload
from services.simulation import service as sim


router = APIRouter(prefix="/simulations", tags=["simulations"])

# Ceiling on how long a connected socket waits before re-reading its run's state from
# the DB. When REDIS_URL is set, a RunStore write publishes instantly and this only
# acts as a backstop against a missed/dropped publish; unconfigured, it's the sole
# poll interval, same as before Redis was introduced. Either way, correctness under
# autoscaling comes from every instance independently re-checking the same shared
# Turso row, not from instances coordinating with each other.
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
        async with subscribe_run_updates(run_id) as pubsub:
            while True:
                try:
                    state = await sim.get_simulation_state(run_id)
                except (RunNotFound, RunExpired):
                    await websocket.send_json({"type": "expired"})
                    break
                if state != last_state:
                    await websocket.send_json({"type": "state", "data": state})
                    last_state = state

                if pubsub is not None:
                    # Blocks up to STATE_POLL_INTERVAL_SECONDS for a publish on this
                    # run's channel, returning early the instant one arrives — same
                    # backstop cadence as the plain-poll branch below if none does.
                    wait_task = asyncio.create_task(
                        pubsub.get_message(
                            ignore_subscribe_messages=True,
                            timeout=STATE_POLL_INTERVAL_SECONDS,
                        )
                    )
                else:
                    wait_task = asyncio.create_task(asyncio.sleep(STATE_POLL_INTERVAL_SECONDS))

                done, _pending = await asyncio.wait(
                    {disconnect_task, wait_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if disconnect_task in done:
                    wait_task.cancel()
                    break
    except WebSocketDisconnect:
        pass
    finally:
        disconnect_task.cancel()
        try:
            await disconnect_task
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
