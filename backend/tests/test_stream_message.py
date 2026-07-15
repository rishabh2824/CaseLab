"""stream_message: SSE event sequencing, and — the bug this suite caught —
whether a client disconnecting mid-generation (e.g. reloading the page while
waiting for a reply) can cancel the reply generation and lose it.
"""

import asyncio

import pytest

from services.simulation import service


def _prepared(**over):
    base = {
        "kind": "normal",
        "run_id": "r1",
        "persona_id": "p1",
        "system": [{"type": "text", "text": "sys"}],
        "messages": [{"role": "user", "content": "hi"}],
        "referral_handles": {},
        "file_handles": {},
    }
    base.update(over)
    return base


def _fake_apply(reply_holder):
    async def fake_apply_reply_decisions(run_id, prepared, unlock_handles, share_handles, persona_id, reply):
        reply_holder["persisted"] = reply
        return (
            [],
            [],
            [{"role": "assistant", "content": reply}],
            {"chat_ended": False, "chat_end_reason": None, "warning_count": 0},
        )

    return fake_apply_reply_decisions


class TestBoundaryPassthrough:
    async def test_yields_precomputed_meta_delta_done_without_generating(self):
        prepared = {
            "kind": "boundary",
            "reply": "I am not able to follow that.",
            "history": [{"role": "assistant", "content": "I am not able to follow that."}],
            "meta": {"new_contacts": [], "shared_files": [], "chat_ended": False, "chat_end_reason": None, "warning_count": 1},
        }
        events = [event async for event in service.stream_message(prepared)]
        assert [e["event"] for e in events] == ["meta", "delta", "done"]

    async def test_empty_boundary_reply_skips_delta(self):
        prepared = {
            "kind": "boundary",
            "reply": "",
            "history": [],
            "meta": {"new_contacts": [], "shared_files": [], "chat_ended": False, "chat_end_reason": None, "warning_count": 1},
        }
        events = [event async for event in service.stream_message(prepared)]
        assert [e["event"] for e in events] == ["meta", "done"]


class TestNormalReplyHappyPath:
    async def test_connected_client_receives_the_full_event_sequence(self, monkeypatch):
        async def fake_persona_reply(system, messages):
            return '{"reply": "Hi there", "introduce": [], "send_files": []}'

        monkeypatch.setattr(service, "personaReply", fake_persona_reply)
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply({}))

        events = [event async for event in service.stream_message(_prepared())]
        assert [e["event"] for e in events] == ["meta", "delta", "done"]

    async def test_generation_failure_yields_a_single_error_event(self, monkeypatch):
        async def failing_persona_reply(system, messages):
            raise RuntimeError("boom")

        monkeypatch.setattr(service, "personaReply", failing_persona_reply)

        events = [event async for event in service.stream_message(_prepared())]
        assert [e["event"] for e in events] == ["error"]

    async def test_unparseable_reply_yields_error_and_does_not_persist(self, monkeypatch):
        persisted = {}

        async def fake_persona_reply(system, messages):
            return "not json at all"

        monkeypatch.setattr(service, "personaReply", fake_persona_reply)
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply(persisted))

        events = [event async for event in service.stream_message(_prepared())]
        assert [e["event"] for e in events] == ["error"]
        assert persisted == {}


class TestSurvivesClientDisconnect:
    """The bug: sse-starlette cancels the whole generator's task group the
    instant the client disconnects (see EventSourceResponse._listen_for_disconnect
    + cancel_on_finish in sse_starlette/sse.py). Before this fix, that cancellation
    reached straight into the in-flight `personaReply()` / `apply_reply_decisions()`
    call, so a page reload while waiting for a reply silently discarded it forever.
    """

    async def test_reply_still_persists_after_the_consumer_is_cancelled(self, monkeypatch):
        reply_started = asyncio.Event()
        release_reply = asyncio.Event()
        persisted = {}

        async def slow_persona_reply(system, messages):
            reply_started.set()
            await release_reply.wait()  # simulates the in-flight Anthropic call
            return '{"reply": "Hello!", "introduce": [], "send_files": []}'

        monkeypatch.setattr(service, "personaReply", slow_persona_reply)
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply(persisted))

        agen = service.stream_message(_prepared())
        # Mirrors how EventSourceResponse actually drives the generator: as a
        # separate task, so it can be cancelled independently — exactly what
        # sse-starlette's task-group cancellation does on client disconnect.
        consumer = asyncio.create_task(agen.__anext__())

        await asyncio.wait_for(reply_started.wait(), timeout=1)
        consumer.cancel()  # the "page reload"
        # asyncio.shield's documented contract: the cancellation reaches the
        # awaiting coroutine, which we catch — so the generator ends cleanly
        # (StopAsyncIteration) rather than propagating CancelledError further.
        # That's what lets the shielded task itself keep running untouched.
        with pytest.raises(StopAsyncIteration):
            await consumer

        assert persisted == {}  # the "LLM" hasn't returned yet

        release_reply.set()  # let generation finish now that the client is gone
        for _ in range(100):
            if persisted:
                break
            await asyncio.sleep(0)

        assert persisted.get("persisted") == "Hello!"  # proves it was NOT cancelled

    async def test_disconnect_moments_after_generation_starts_still_completes(self, monkeypatch):
        # Cancel as early as possible — right after the detached task is
        # spawned, before the "LLM" call itself has had a chance to run.
        persisted = {}

        async def fake_persona_reply(system, messages):
            return '{"reply": "Still here", "introduce": [], "send_files": []}'

        monkeypatch.setattr(service, "personaReply", fake_persona_reply)
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply(persisted))

        agen = service.stream_message(_prepared())
        consumer = asyncio.create_task(agen.__anext__())
        await asyncio.sleep(0)  # let the consumer run far enough to spawn the detached task
        consumer.cancel()
        with pytest.raises(StopAsyncIteration):
            await consumer

        for _ in range(100):
            if persisted:
                break
            await asyncio.sleep(0)

        assert persisted.get("persisted") == "Still here"
