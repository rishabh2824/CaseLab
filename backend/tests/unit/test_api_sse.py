"""HTTP-level tests for POST /api/simulations/{run_id}/message, which returns
an EventSourceResponse wrapping stream.streamMessage (api/simulations.py).
services.simulation.turn.prepareTurn and services.simulation.stream.streamTurn are
monkeypatched wholesale -- services/simulation/ already has its own hermetic harness
(tests/unit/conftest.py's `sim` fixture) that drives the real prompt/turn-state/reads
code; this file only checks the HTTP transport around it: the response is genuinely
`text/event-stream`, frames arrive in order, and a DomainError raised by prepareTurn
-- which streamMessage runs *inside* the generator, after the response has already
committed to 200 + text/event-stream -- surfaces as a well-formed "error" frame
rather than an HTTP status code or a malformed/half-open stream.

Reuses the `client` fixture from test_api_http.py -- /api/simulations routes
carry no admin dependency (students hit them directly), so `as_admin` is not
needed here.
"""

from __future__ import annotations

import json

import domain_errors as de
import services.simulation.stream as stream_service
import services.simulation.turn as turn_service
from models.runtime import ErrorFrame, BoundaryTurn, TurnMeta
from tests.unit.test_api_http import client  # noqa: F401  (re-exported fixture)


async def test_send_message_streams_sse_frames_in_order(client, monkeypatch):  # noqa: F811
    async def fake_message(run_id, payload):
        return {"kind": "normal", "run_id": run_id, "persona_id": payload.persona_id}

    async def fake_stream(prepared):
        yield {"event": "delta", "data": json.dumps({"text": "Hello "})}
        yield {"event": "delta", "data": json.dumps({"text": "there."})}
        yield {"event": "meta", "data": json.dumps({"new_contacts": [], "shared_files": []})}
        yield {"event": "done", "data": json.dumps({"reply": "Hello there."})}

    monkeypatch.setattr(turn_service, "prepareTurn", fake_message)
    monkeypatch.setattr(stream_service, "streamTurn", fake_stream)

    async with client.stream(
        "POST", "/api/simulations/run-123/message", json={"persona_id": "A", "message": "hi"}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        raw = (await resp.aread()).decode()

    # sse-starlette frames as `event: <name>\r\ndata: <payload>\r\n\r\n` (or \n\n
    # depending on version) -- rather than pin the exact wire delimiter, just
    # assert the four events appear, in order, with their expected payloads.
    event_positions = [raw.index(f"event: {name}") for name in ("delta", "delta", "meta", "done")]
    assert event_positions == sorted(event_positions), raw

    assert f"data: {json.dumps({'text': 'Hello '})}" in raw
    assert f"data: {json.dumps({'text': 'there.'})}" in raw
    assert f"data: {json.dumps({'reply': 'Hello there.'})}" in raw


async def test_send_message_domain_error_surfaces_as_sse_error_frame(client, monkeypatch):  # noqa: F811
    """stream.streamMessage runs turn.prepareTurn() (the "prepare" step) *inside* its
    generator, which Starlette only starts iterating after EventSourceResponse has
    already sent a 200 + text/event-stream -- that's the whole point (it lets the
    response start before prepareTurn's DB round trips + classifier fan-out finish).
    So a DomainError raised there can no longer become an HTTP status code; it must
    surface as a well-formed "error" frame instead."""

    async def fake_message(run_id, payload):
        raise de.InvalidRequest("Persona is not available yet.")

    monkeypatch.setattr(turn_service, "prepareTurn", fake_message)

    async with client.stream(
        "POST", "/api/simulations/run-123/message", json={"persona_id": "A", "message": "hi"}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        raw = (await resp.aread()).decode()

    assert "event: error" in raw
    expected = ErrorFrame(detail="Persona is not available yet.", code=None).model_dump_json()
    assert f"data: {expected}" in raw


async def test_send_message_conversation_ended_error_carries_code(client, monkeypatch):  # noqa: F811
    """turn.CONVERSATION_ENDED is a structured {message, code} detail (like
    services/cases.py's VERSION_CONFLICT) -- run.svelte.ts's #runSend branches on
    that `code` to mark the contact's chat as ended locally, so it must survive the
    move from an ApiError's JSON `detail` into the SSE ErrorFrame's `code` field."""

    async def fake_message(run_id, payload):
        raise de.InvalidRequest({"message": "This conversation has ended.", "code": "conversation_ended"})

    monkeypatch.setattr(turn_service, "prepareTurn", fake_message)

    async with client.stream(
        "POST", "/api/simulations/run-123/message", json={"persona_id": "A", "message": "hi"}
    ) as resp:
        assert resp.status_code == 200
        raw = (await resp.aread()).decode()

    assert "event: error" in raw
    expected = ErrorFrame(detail="This conversation has ended.", code="conversation_ended").model_dump_json()
    assert f"data: {expected}" in raw


async def test_send_message_boundary_reply_still_streams_over_sse(client, monkeypatch):  # noqa: F811
    """A 'boundary' kind response (e.g. harassment/nonsense flagged) is a
    different code path in streamTurn than 'normal' -- it yields
    meta/delta/done directly with no producer task -- and must still come
    back as a well-formed SSE stream rather than only the 'normal' path being
    covered."""

    async def fake_message(run_id, payload):
        return BoundaryTurn(
            run_id=run_id,
            persona_id=payload.persona_id,
            reply="Let's keep this professional.",
            meta=TurnMeta(new_contacts=[], shared_files=[], chat_ended=False, chat_end_reason=None, warning_count=1),
        )

    monkeypatch.setattr(turn_service, "prepareTurn", fake_message)
    monkeypatch.setattr(stream_service, "streamTurn", stream_service.streamTurn)  # exercise the real generator

    async with client.stream(
        "POST", "/api/simulations/run-123/message", json={"persona_id": "A", "message": "nonsense"}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        raw = (await resp.aread()).decode()

    for name in ("meta", "delta", "done"):
        assert f"event: {name}" in raw, raw
    assert "Let's keep this professional." in raw
