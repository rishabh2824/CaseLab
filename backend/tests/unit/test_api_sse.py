"""HTTP-level tests for POST /api/simulations/{run_id}/message, which returns
an EventSourceResponse (api/simulations.py). services.simulation.service.message
and .streamMessage are monkeypatched wholesale -- services/simulation/ already
has its own hermetic harness (tests/unit/conftest.py's `sim` fixture) that
drives the real prompt/turn-state/reads code; this file only checks the HTTP
transport around it: the response is genuinely `text/event-stream`, frames
arrive in order, and a DomainError raised before any streaming starts comes
back as an ordinary JSON error rather than a malformed/half-open stream.

Reuses the `client` fixture from test_api_http.py -- /api/simulations routes
carry no admin dependency (students hit them directly), so `as_admin` is not
needed here.
"""

from __future__ import annotations

import json

import domain_errors as de
import services.simulation.service as sim_service
from tests.unit.test_api_http import client  # noqa: F401  (re-exported fixture)


async def test_send_message_streams_sse_frames_in_order(client, monkeypatch):  # noqa: F811
    async def fake_message(run_id, payload):
        return {"kind": "normal", "run_id": run_id, "persona_id": payload.persona_id}

    async def fake_stream(prepared):
        yield {"event": "delta", "data": json.dumps({"text": "Hello "})}
        yield {"event": "delta", "data": json.dumps({"text": "there."})}
        yield {"event": "meta", "data": json.dumps({"new_contacts": [], "shared_files": []})}
        yield {"event": "done", "data": json.dumps({"reply": "Hello there.", "history": []})}

    monkeypatch.setattr(sim_service, "message", fake_message)
    monkeypatch.setattr(sim_service, "streamMessage", fake_stream)

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
    assert f"data: {json.dumps({'reply': 'Hello there.', 'history': []})}" in raw


async def test_send_message_domain_error_before_streaming_returns_json(client, monkeypatch):  # noqa: F811
    """sim.message() (the "prepare" step) runs to completion before
    EventSourceResponse(sim.streamMessage(...)) is even constructed -- a
    DomainError raised there must surface as main.py's normal JSON error
    response, not as a broken/empty SSE stream."""

    async def fake_message(run_id, payload):
        raise de.InvalidRequest("Persona is not available yet.")

    monkeypatch.setattr(sim_service, "message", fake_message)

    resp = await client.post("/api/simulations/run-123/message", json={"persona_id": "A", "message": "hi"})
    assert resp.status_code == 400
    assert resp.json() == {"detail": "Persona is not available yet."}
    assert not resp.headers.get("content-type", "").startswith("text/event-stream")


async def test_send_message_boundary_reply_still_streams_over_sse(client, monkeypatch):  # noqa: F811
    """A 'boundary' kind response (e.g. harassment/nonsense flagged) is a
    different code path in streamMessage than 'normal' -- it yields
    meta/delta/done directly with no producer task -- and must still come
    back as a well-formed SSE stream rather than only the 'normal' path being
    covered."""

    async def fake_message(run_id, payload):
        return {
            "kind": "boundary",
            "run_id": run_id,
            "persona_id": payload.persona_id,
            "reply": "Let's keep this professional.",
            "history": [{"role": "assistant", "content": "Let's keep this professional."}],
            "meta": {"new_contacts": [], "shared_files": [], "warning_count": 1, "ended": False, "chat_end_reason": None},
        }

    monkeypatch.setattr(sim_service, "message", fake_message)
    monkeypatch.setattr(sim_service, "streamMessage", sim_service.streamMessage)  # exercise the real generator

    async with client.stream(
        "POST", "/api/simulations/run-123/message", json={"persona_id": "A", "message": "nonsense"}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        raw = (await resp.aread()).decode()

    for name in ("meta", "delta", "done"):
        assert f"event: {name}" in raw, raw
    assert "Let's keep this professional." in raw
