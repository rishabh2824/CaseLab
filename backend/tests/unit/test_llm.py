"""infra/llm.py — the OpenAI-facing seam.

No network calls: `infra.llm.client` is monkeypatched to a fake object built
from plain classes that mirror the shape the openai SDK streams back
(`chunk.choices[0].delta.content` / `.tool_calls[i].function.arguments`), and
`chat` is monkeypatched directly for the classifier tests, which only care
about how classifyHarassment/classifier interpret the text `chat` returns.
"""

from __future__ import annotations

import json

import httpx
import pytest
from openai import APIConnectionError

from infra import llm as llm_module


# --------------------------------------------------------------------------
# fakes mirroring the openai streaming response shape
# --------------------------------------------------------------------------


class FakeFunction:
    def __init__(self, arguments):
        self.arguments = arguments


class FakeToolCallDelta:
    def __init__(self, index, arguments):
        self.index = index
        self.function = FakeFunction(arguments)


class FakeDelta:
    def __init__(self, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls


class FakeChoice:
    def __init__(self, delta):
        self.delta = delta


class FakeChunk:
    def __init__(self, choices):
        self.choices = choices


class FakeStream:
    """An async-iterable stream of chunks, optionally raising after the
    chunks are exhausted (simulating a mid/end-of-stream connection drop)."""

    def __init__(self, chunks, exc: Exception | None = None):
        self.chunks = chunks
        self.exc = exc

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for chunk in self.chunks:
            yield chunk
        if self.exc is not None:
            raise self.exc


class FakeCompletions:
    """`responses` is consumed one per call to create(): an Exception entry
    is raised immediately (simulating create() itself failing to open the
    stream); anything else is returned as the stream."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    async def create(self, **kwargs):
        self.calls += 1
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FakeClient:
    def __init__(self, completions: FakeCompletions):
        self.chat = type("Chat", (), {"completions": completions})()


def connectionError() -> APIConnectionError:
    return APIConnectionError(request=httpx.Request("POST", "https://example.test/v1/chat/completions"))


# --------------------------------------------------------------------------
# formatTranscript
# --------------------------------------------------------------------------


def test_format_transcript_empty_conversation():
    transcript, user_count, assistant_count = llm_module.formatTranscript([])
    assert transcript == "No conversation yet."
    assert (user_count, assistant_count) == (0, 0)


def test_format_transcript_counts_and_formats_lines():
    conversation = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    transcript, user_count, assistant_count = llm_module.formatTranscript(conversation, limit=8)
    assert transcript == "user: hi\nassistant: hello"
    assert (user_count, assistant_count) == (1, 1)


def test_format_transcript_window_is_applied_before_system_filtering():
    # The slice `conversation[-limit:]` happens BEFORE system turns are
    # dropped. So a system turn occupying a slot inside the window still
    # "counts" against the window size, silently pushing an older
    # user/assistant turn out of the transcript entirely — even though the
    # system turn itself never appears in the output. With limit=3 here, the
    # window is the last 3 messages (system, user u1, assistant a1); "u0"
    # is outside that window and is lost, even though only 2 of the 3
    # windowed messages actually end up in the transcript.
    conversation = [
        {"role": "user", "content": "u0"},
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "a1"},
    ]
    transcript, user_count, assistant_count = llm_module.formatTranscript(conversation, limit=3)
    assert "u0" not in transcript
    assert transcript == "user: u1\nassistant: a1"
    assert (user_count, assistant_count) == (1, 1)


def test_format_transcript_all_system_within_window_yields_placeholder():
    conversation = [{"role": "system", "content": "sys"}]
    transcript, user_count, assistant_count = llm_module.formatTranscript(conversation)
    assert transcript == "No conversation yet."
    assert (user_count, assistant_count) == (0, 0)


# --------------------------------------------------------------------------
# personaReplyStream
# --------------------------------------------------------------------------


async def test_persona_reply_stream_yields_text_deltas_in_order(monkeypatch):
    chunks = [
        FakeChunk([FakeChoice(FakeDelta(content="Hello"))]),
        FakeChunk([FakeChoice(FakeDelta(content=" there"))]),
        FakeChunk([FakeChoice(FakeDelta(content=None, tool_calls=None))]),
    ]
    completions = FakeCompletions([FakeStream(chunks)])
    monkeypatch.setattr(llm_module, "client", FakeClient(completions))

    events = [event async for event in llm_module.personaReplyStream([{"role": "user", "content": "hi"}])]

    assert events[0] == {"type": "delta", "text": "Hello"}
    assert events[1] == {"type": "delta", "text": " there"}
    assert events[2] == {"type": "tool_call", "arguments": None}


async def test_persona_reply_stream_reassembles_tool_call_fragments_across_chunks_and_indices(monkeypatch):
    full = json.dumps({"introduce": ["R1"], "send_files": []})
    mid = len(full) // 2
    index0_part1, index0_part2 = full[: mid // 2], full[mid // 2 : mid]
    index1_part = full[mid:]
    # index 1's fragment arrives BEFORE index 0's second fragment, to prove
    # reassembly orders by tool-call index, not arrival order.
    chunks = [
        FakeChunk([FakeChoice(FakeDelta(tool_calls=[FakeToolCallDelta(0, index0_part1)]))]),
        FakeChunk([FakeChoice(FakeDelta(tool_calls=[FakeToolCallDelta(1, index1_part)]))]),
        FakeChunk([FakeChoice(FakeDelta(tool_calls=[FakeToolCallDelta(0, index0_part2)]))]),
    ]
    completions = FakeCompletions([FakeStream(chunks)])
    monkeypatch.setattr(llm_module, "client", FakeClient(completions))

    events = [event async for event in llm_module.personaReplyStream([])]

    assert events[-1] == {"type": "tool_call", "arguments": {"introduce": ["R1"], "send_files": []}}


async def test_persona_reply_stream_malformed_tool_call_json_yields_none_arguments(monkeypatch):
    chunks = [FakeChunk([FakeChoice(FakeDelta(tool_calls=[FakeToolCallDelta(0, "{not valid json")]))])]
    completions = FakeCompletions([FakeStream(chunks)])
    monkeypatch.setattr(llm_module, "client", FakeClient(completions))

    events = [event async for event in llm_module.personaReplyStream([])]

    assert events == [{"type": "tool_call", "arguments": None}]


async def test_persona_reply_stream_skips_chunks_with_empty_choices(monkeypatch):
    chunks = [
        FakeChunk([]),  # must be skipped, not raise IndexError on choices[0]
        FakeChunk([FakeChoice(FakeDelta(content="Hi"))]),
    ]
    completions = FakeCompletions([FakeStream(chunks)])
    monkeypatch.setattr(llm_module, "client", FakeClient(completions))

    events = [event async for event in llm_module.personaReplyStream([])]

    assert events[0] == {"type": "delta", "text": "Hi"}


async def test_persona_reply_stream_retries_retryable_exception_before_any_output(monkeypatch):
    good_chunks = [FakeChunk([FakeChoice(FakeDelta(content="Recovered"))])]
    completions = FakeCompletions([connectionError(), FakeStream(good_chunks)])
    monkeypatch.setattr(llm_module, "client", FakeClient(completions))

    events = [event async for event in llm_module.personaReplyStream([])]

    assert completions.calls == 2
    assert events[0] == {"type": "delta", "text": "Recovered"}


async def test_persona_reply_stream_does_not_retry_after_text_already_yielded(monkeypatch):
    chunks = [FakeChunk([FakeChoice(FakeDelta(content="Partial"))])]
    stream = FakeStream(chunks, exc=connectionError())
    completions = FakeCompletions([stream])
    monkeypatch.setattr(llm_module, "client", FakeClient(completions))

    events = []
    with pytest.raises(APIConnectionError):
        async for event in llm_module.personaReplyStream([]):
            events.append(event)

    assert events == [{"type": "delta", "text": "Partial"}]
    assert completions.calls == 1  # no retry once text has already gone out


async def test_persona_reply_stream_non_retryable_exception_is_never_retried(monkeypatch):
    completions = FakeCompletions([ValueError("boom")])
    monkeypatch.setattr(llm_module, "client", FakeClient(completions))

    with pytest.raises(ValueError):
        async for _ in llm_module.personaReplyStream([]):
            pass

    assert completions.calls == 1


# --------------------------------------------------------------------------
# classifyHarassment — the silent-fallback contract
# --------------------------------------------------------------------------


async def test_classify_harassment_nonsense_label(monkeypatch):
    async def fakeChat(**kwargs):
        return "NONSENSE"

    monkeypatch.setattr(llm_module, "chat", fakeChat)
    assert await llm_module.classifyHarassment("asdkjh", []) == "nonsense"


async def test_classify_harassment_normal_label(monkeypatch):
    async def fakeChat(**kwargs):
        return "NORMAL"

    monkeypatch.setattr(llm_module, "chat", fakeChat)
    assert await llm_module.classifyHarassment("hi", []) == "normal"


async def test_classify_harassment_unknown_label_defaults_to_normal(monkeypatch):
    async def fakeChat(**kwargs):
        return "BANANA"

    monkeypatch.setattr(llm_module, "chat", fakeChat)
    assert await llm_module.classifyHarassment("hi", []) == "normal"


async def test_classify_harassment_exception_falls_back_to_normal(monkeypatch):
    async def fakeChat(**kwargs):
        raise RuntimeError("upstream is down")

    monkeypatch.setattr(llm_module, "chat", fakeChat)
    assert await llm_module.classifyHarassment("hi", []) == "normal"


async def test_classify_harassment_is_case_and_whitespace_insensitive(monkeypatch):
    async def fakeChat(**kwargs):
        return "  nonsense  "

    monkeypatch.setattr(llm_module, "chat", fakeChat)
    assert await llm_module.classifyHarassment("hi", []) == "nonsense"


# --------------------------------------------------------------------------
# classifier
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("YES", True),
        ("yes", True),
        (" Yes ", True),
        ("YES.", True),
        ("NO", False),
        ("", False),
        ("maybe", False),
    ],
)
async def test_classifier_only_true_for_a_yes_prefix(monkeypatch, raw, expected):
    async def fakeChat(**kwargs):
        return raw

    monkeypatch.setattr(llm_module, "chat", fakeChat)
    assert await llm_module.classifier("system", "user") is expected


# --------------------------------------------------------------------------
# chat
# --------------------------------------------------------------------------


async def test_chat_raises_runtime_error_when_client_not_initialized(monkeypatch):
    monkeypatch.setattr(llm_module, "client", None)
    with pytest.raises(RuntimeError):
        await llm_module.chat(model="m", messages=[], max_tokens=10, timeout=5)
