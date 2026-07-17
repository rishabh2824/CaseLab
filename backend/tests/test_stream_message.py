"""stream_message: SSE event sequencing for streamed persona replies, and — the
bug this suite caught — whether a client disconnecting mid-generation (e.g.
reloading the page while waiting for a reply) can cancel the reply generation
and lose it.

Normal replies now stream token-by-token, so the event order is
``delta* -> meta -> done`` (meta trails the text because the referral/file
decisions are only known once the full reply is parsed).
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


def _stream_of(*chunks):
    """Build a fake personaReplyStream that yields the given text chunks."""

    async def fake_stream(system, messages):
        for chunk in chunks:
            yield chunk

    return fake_stream


def _events(data):
    return [e["event"] for e in data]


class TestBoundaryPassthrough:
    async def test_yields_precomputed_meta_delta_done_without_generating(self):
        prepared = {
            "kind": "boundary",
            "reply": "I am not able to follow that.",
            "history": [{"role": "assistant", "content": "I am not able to follow that."}],
            "meta": {"new_contacts": [], "shared_files": [], "chat_ended": False, "chat_end_reason": None, "warning_count": 1},
        }
        events = [event async for event in service.stream_message(prepared)]
        assert _events(events) == ["meta", "delta", "done"]

    async def test_empty_boundary_reply_skips_delta(self):
        prepared = {
            "kind": "boundary",
            "reply": "",
            "history": [],
            "meta": {"new_contacts": [], "shared_files": [], "chat_ended": False, "chat_end_reason": None, "warning_count": 1},
        }
        events = [event async for event in service.stream_message(prepared)]
        assert _events(events) == ["meta", "done"]


class TestNormalReplyHappyPath:
    async def test_streams_delta_then_meta_then_done(self, monkeypatch):
        reply = "Hi there"
        monkeypatch.setattr(
            service, "personaReplyStream",
            _stream_of(f'{{"reply": "{reply}", "introduce": [], "send_files": []}}'),
        )
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply({}))

        events = [event async for event in service.stream_message(_prepared())]
        assert _events(events) == ["delta", "meta", "done"]

    async def test_concatenated_deltas_equal_the_reply(self, monkeypatch):
        # The reply arrives split across several text_delta chunks (as it would
        # over the wire); the streamed deltas must reassemble into the reply.
        monkeypatch.setattr(
            service, "personaReplyStream",
            _stream_of('{"reply": "Hello ', "there, ", 'friend", "introduce": [], "send_files": []}'),
        )
        persisted = {}
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply(persisted))

        events = [event async for event in service.stream_message(_prepared())]
        deltas = [e for e in events if e["event"] == "delta"]
        import json
        streamed = "".join(json.loads(e["data"])["text"] for e in deltas)
        assert streamed == "Hello there, friend"
        assert persisted["persisted"] == "Hello there, friend"

    async def test_fallback_single_delta_when_extractor_never_finds_reply(self, monkeypatch):
        # If the incremental lexer never surfaces the reply (simulated here), the
        # authoritative parse still yields it and it is emitted once as a fallback
        # delta before meta/done.
        class _BlindExtractor:
            found_reply = False
            done = False

            def feed(self, chunk):
                return ""

        monkeypatch.setattr(service, "ReplyExtractor", _BlindExtractor)
        monkeypatch.setattr(
            service, "personaReplyStream",
            _stream_of('{"reply": "Recovered", "introduce": [], "send_files": []}'),
        )
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply({}))

        events = [event async for event in service.stream_message(_prepared())]
        assert _events(events) == ["delta", "meta", "done"]
        import json
        assert json.loads(events[0]["data"])["text"] == "Recovered"

    async def test_generation_failure_yields_a_single_error_event(self, monkeypatch):
        async def failing_stream(system, messages):
            raise RuntimeError("boom")
            yield  # pragma: no cover — makes this an async generator

        monkeypatch.setattr(service, "personaReplyStream", failing_stream)

        events = [event async for event in service.stream_message(_prepared())]
        assert _events(events) == ["error"]

    async def test_failure_after_some_deltas_yields_deltas_then_error(self, monkeypatch):
        # A mid-stream failure after text has already been forwarded: the user
        # sees the partial text, then an error; nothing is persisted.
        persisted = {}

        async def dies_midway(system, messages):
            yield '{"reply": "Half a sen'
            raise RuntimeError("connection dropped")

        monkeypatch.setattr(service, "personaReplyStream", dies_midway)
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply(persisted))

        events = [event async for event in service.stream_message(_prepared())]
        assert _events(events) == ["delta", "error"]
        assert persisted == {}

    async def test_unparseable_reply_yields_error_and_does_not_persist(self, monkeypatch):
        persisted = {}
        monkeypatch.setattr(service, "personaReplyStream", _stream_of("not json at all"))
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply(persisted))

        events = [event async for event in service.stream_message(_prepared())]
        assert _events(events) == ["error"]
        assert persisted == {}


class TestSurvivesClientDisconnect:
    """The bug: sse-starlette cancels the whole generator's task group the
    instant the client disconnects (see EventSourceResponse._listen_for_disconnect
    + cancel_on_finish in sse_starlette/sse.py). The reply is generated by a
    detached producer task that this generator only reads from via a queue, so a
    disconnect cancels the read — not the generation, which runs to completion and
    persists.
    """

    async def test_reply_still_persists_after_the_consumer_is_cancelled(self, monkeypatch):
        reply_started = asyncio.Event()
        release_reply = asyncio.Event()
        persisted = {}

        async def slow_stream(system, messages):
            reply_started.set()
            await release_reply.wait()  # simulates the in-flight Anthropic call
            yield '{"reply": "Hello!", "introduce": [], "send_files": []}'

        monkeypatch.setattr(service, "personaReplyStream", slow_stream)
        monkeypatch.setattr(service, "apply_reply_decisions", _fake_apply(persisted))

        agen = service.stream_message(_prepared())
        # Mirrors how EventSourceResponse actually drives the generator: as a
        # separate task, so it can be cancelled independently — exactly what
        # sse-starlette's task-group cancellation does on client disconnect.
        consumer = asyncio.create_task(agen.__anext__())

        await asyncio.wait_for(reply_started.wait(), timeout=1)
        consumer.cancel()  # the "page reload"
        # The consumer catches the cancellation at its queue.get() and returns,
        # so the generator ends cleanly (StopAsyncIteration) rather than
        # propagating CancelledError — the detached producer keeps running.
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
        # spawned, before the "LLM" stream itself has had a chance to run.
        persisted = {}
        monkeypatch.setattr(
            service, "personaReplyStream",
            _stream_of('{"reply": "Still here", "introduce": [], "send_files": []}'),
        )
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
