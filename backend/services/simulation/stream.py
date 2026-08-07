import asyncio
from pydantic import BaseModel
from domain_errors import DomainError
from models.runtime import (
    DeltaFrame, DoneFrame, ErrorFrame, BoundaryTurn, NormalTurn, PreparedTurn, TurnMeta,
)
from models.simulations import SendMessage
from infra.llm import personaReplyStream
from infra.settings import GENERATION_WALL_CLOCK_TIMEOUT
from services.simulation import turn
from services.simulation.prompt import cleanReply, coerceHandles, parseReply
from services.simulation.reply_stream import ReplyExtractor
from services.simulation.turn import applyDecisions


# One Server-Sent Event as a sse-starlette dict; the response class handles the wire framing
def sse(event: str, data: BaseModel) -> dict:
    return {"event": event, "data": data.model_dump_json()}


# Strong references to in-flight generations, just a set so asyncio doesn't garbage-collect a task mid-flight
# Entries remove themselves via add_done_callback once finished.
generations: set[asyncio.Task] = set()


# Takes the cleaned response from the LLM and saves it to DB.
async def generateReply(prepared: NormalTurn, queue: asyncio.Queue) -> None:
    run_id = prepared.run_id
    persona_id = prepared.persona_id
    extractor = ReplyExtractor()
    raw_parts: list[str] = []

    def emit(event: str, data: BaseModel) -> None:
        queue.put_nowait(sse(event, data))

    try:
        # No fallback here (unlike classifyHarassment's silent "normal" default) —
        # a reply that fails to generate/stream has nothing safe to fall back to,
        # so the message fails and the user is asked to resend it.
        try:
            async with asyncio.timeout(GENERATION_WALL_CLOCK_TIMEOUT):
                async for event in personaReplyStream(prepared.messages):
                    if event["type"] == "delta":
                        raw_parts.append(event["text"])
                        delta = extractor.feed(event["text"])
                        if delta:
                            emit("delta", DeltaFrame(text=delta))
        except Exception:
            emit("error", ErrorFrame(detail="The reply could not be generated. Please resend your message."))
            return

        # Authoritative parse of the full raw text — the streamed deltas are a
        # best-effort preview; this is the reply of record for persistence + done.
        envelope = parseReply("".join(raw_parts))
        reply = cleanReply(str(envelope.get("reply") or "")) if envelope else ""
        if not reply:
            emit("error", ErrorFrame(detail="The reply could not be generated. Please resend your message."))
            return

        unlock_handles = coerceHandles(envelope.get("introduce"))
        share_handles = coerceHandles(envelope.get("send_files"))

        try:
            new_contacts, shared_files, chat_state = await applyDecisions(
                run_id, prepared, unlock_handles, share_handles, persona_id, reply
            )
        except Exception:
            emit("error", ErrorFrame(detail="The reply could not be saved. Please try again."))
            return

        if not extractor.found_reply:
            # The incremental extractor never surfaced the reply text (an unparseable
            # stream, or `reply` absent from the streamed view) — emit it once now,
            # matching the old single-delta behavior. An extractor bug can degrade the
            # live preview but never lose the reply, which is the authoritative
            # value parsed above.
            emit("delta", DeltaFrame(text=reply))

        emit("meta", TurnMeta(new_contacts=new_contacts, shared_files=shared_files, **chat_state))
        emit("done", DoneFrame(reply=reply))
    finally:
        queue.put_nowait(None)  # sentinel: tell the consumer the stream is complete


# Sends the final response to frontend
async def streamTurn(prepared: PreparedTurn):
    if isinstance(prepared, BoundaryTurn):
        # reply is already fully computed and persisted in turn.prepareTurn's
        # flag_and_append mutate — nothing left to write here, just yield the already-known value.
        yield sse("meta", prepared.meta)
        boundary_reply = prepared.reply
        if boundary_reply:
            yield sse("delta", DeltaFrame(text=boundary_reply))
        yield sse("done", DoneFrame(reply=boundary_reply))
        return

    # --- normal: the producer runs as a task this generator does not own, and
    # streams SSE frames through `queue`. sse-starlette cancels this generator's
    # whole task group the instant the client disconnects (e.g. a page reload);
    # because the producer is a separate, referenced task, that cancellation
    # reaches only our `queue.get()` here — the producer keeps running and
    # persists the reply regardless of whether anyone is still listening.
    queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(generateReply(prepared, queue))
    generations.add(task)
    task.add_done_callback(generations.discard)

    while True:
        try:
            item = await queue.get()
        except asyncio.CancelledError:
            return  # client disconnected — producer is unaffected and persists in the background
        if item is None:
            return  # producer signalled completion
        yield item


# Entry point for POST /{run_id}/message (api/simulations.py). Wraps prepareTurn +
# streamTurn into one generator so the route can construct EventSourceResponse
# immediately, without first awaiting prepareTurn — Starlette sends the response
# headers (200 + text/event-stream) as soon as it starts iterating this generator,
# which is *before* this function body actually runs. That moves prepareTurn's ~19 DB
# round trips plus its full classifier fan-out from pre-first-byte latency to
# in-stream latency: the client's fetch() resolves immediately instead of sitting on
# a dead socket for the ~400ms-to-multi-second duration of prepareTurn.
# The cost: by the time prepareTurn's exception is caught below, the response has
# already committed to 200 + SSE, so a DomainError it raises (rate limited, persona
# not available, conversation already ended, etc.) can no longer become an HTTP
# status code — it surfaces as an "error" frame instead, same shape as a
# mid-generation failure in generateReply above.
async def streamMessage(run_id: str, payload: SendMessage):
    try:
        prepared = await turn.prepareTurn(run_id, payload)
    except DomainError as exc:
        if isinstance(exc.detail, dict):
            detail = exc.detail.get("message") or str(exc.detail)
            code = exc.detail.get("code")
        else:
            detail, code = str(exc.detail), None
        yield sse("error", ErrorFrame(detail=detail, code=code))
        return
    except Exception:
        yield sse("error", ErrorFrame(detail="Something went wrong. Please resend your message."))
        return
    async for frame in streamTurn(prepared):
        yield frame
