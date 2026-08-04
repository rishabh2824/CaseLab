from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
from models.simulation_runtime import DeltaFrame, DoneFrame, ErrorFrame, TurnMeta
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

MESSAGE_STREAM_PATH = "/api/simulations/{run_id}/message"
SSE_FRAME_MODELS = (TurnMeta, DeltaFrame, DoneFrame, ErrorFrame)


# POST {MESSAGE_STREAM_PATH} returns EventSourceResponse(sim.streamMessage(...)) below,
# which FastAPI's OpenAPI generation can't see any shape for (no response_model is
# possible on a raw SSE generator) -- so main.py's custom openapi() calls this to
# hand-register the frame shapes into the generated schema, letting `pnpm gen:api`
# pick up TurnMeta/DeltaFrame/DoneFrame/ErrorFrame instead of frontend/src/lib/types.ts
# hand-duplicating them.
def describeMessageStream(schema: dict) -> None:
    schemas = schema["components"]["schemas"]
    for model in SSE_FRAME_MODELS:
        model_schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
        for def_name, def_schema in model_schema.pop("$defs", {}).items():
            schemas.setdefault(def_name, def_schema)
        schemas[model.__name__] = model_schema
    schema["paths"][MESSAGE_STREAM_PATH]["post"]["responses"]["200"] = {
        "description": "Server-Sent Events stream of turn frames (event: meta|delta|done|error).",
        "content": {
            "text/event-stream": {
                "schema": {
                    "oneOf": [{"$ref": f"#/components/schemas/{model.__name__}"} for model in SSE_FRAME_MODELS]
                }
            }
        },
    }


@router.post("/start")
async def startSimulation(payload: StartSimulationPayload) -> RunStateResponse:
    return await sim.startSimulation(payload)


@router.get("/{run_id}")
async def getSimulationState(run_id: str) -> RunStateResponse:
    return await sim.getSimulationState(run_id)


@router.get("/{run_id}/export")
async def exportSimulation(run_id: str) -> ExportResponse:
    return await sim.exportSimulation(run_id)


@router.put("/{run_id}/notes")
async def updateNotes(run_id: str, payload: NotesPayload) -> NotesResponse:
    return await sim.updateNotes(run_id, payload)


@router.post("/{run_id}/message")
async def sendMessage(run_id: str, payload: SendMessagePayload):
    prepared = await sim.message(run_id, payload)
    return EventSourceResponse(sim.streamMessage(prepared))
