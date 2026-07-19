
import httpx
import pytest

from infra import llm


class TestCallBudgets:

    async def test_persona_reply_uses_the_reduced_budget(self, monkeypatch):
        captured = {}

        async def fake_chat(payload, *, timeout, retries):
            captured["timeout"] = timeout
            captured["retries"] = retries
            return {"content": [{"type": "text", "text": "hi"}]}

        monkeypatch.setattr(llm, "chat", fake_chat)
        await llm.personaReply("sys", [{"role": "user", "content": "hi"}])
        assert captured == {"timeout": 30, "retries": 2}

    async def test_yes_no_judge_uses_the_reduced_budget(self, monkeypatch):
        captured = {}

        async def fake_chat(payload, *, timeout, retries):
            captured["timeout"] = timeout
            captured["retries"] = retries
            return {"content": [{"type": "text", "text": "YES"}]}

        monkeypatch.setattr(llm, "chat", fake_chat)
        await llm.classifier("system prompt", "user prompt")
        assert captured == {"timeout": 20, "retries": 2}

    async def test_yes_no_judge_failure_propagates_with_no_fallback(self, monkeypatch):
        async def failing_chat(payload, *, timeout, retries):
            raise RuntimeError("boom")

        monkeypatch.setattr(llm, "chat", failing_chat)
        with pytest.raises(RuntimeError):
            await llm.classifier("system prompt", "user prompt")


class TestClassifyHarassmentFallback:

    async def test_falls_back_to_normal_on_failure(self, monkeypatch):
        async def failing_chat(payload, *, timeout, retries):
            raise RuntimeError("boom")

        monkeypatch.setattr(llm, "chat", failing_chat)
        result = await llm.classifyHarassment("hello", [])
        assert result == "normal"

    async def test_classifies_nonsense_label(self, monkeypatch):
        async def fake_chat(payload, *, timeout, retries):
            return {"content": [{"type": "text", "text": "NONSENSE"}]}

        monkeypatch.setattr(llm, "chat", fake_chat)
        assert await llm.classifyHarassment("asdkjhasd", []) == "nonsense"


async def aiter(items):
    for item in items:
        yield item


class TestParseSseLines:
    async def test_accumulates_data_lines_and_ignores_event_and_comment_lines(self):
        lines = [
            "event: message_start",
            'data: {"type": "message_start"}',
            "",
            ": this is a keep-alive comment",
            "event: content_block_delta",
            'data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}}',
            "",
        ]
        events = [event async for event in llm.parseSseLines(aiter(lines))]
        assert [e["type"] for e in events] == ["message_start", "content_block_delta"]
        assert events[1]["delta"]["text"] == "hi"

    async def test_skips_undecodable_data_payloads(self):
        lines = ["data: not json", "", 'data: {"type": "ok"}', ""]
        events = [event async for event in llm.parseSseLines(aiter(lines))]
        assert [e["type"] for e in events] == ["ok"]


class FakeStreamResponse:
    def __init__(self, status_code, lines):
        self.status_code = status_code
        self.lines = lines

    async def aread(self):
        return b""

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("POST", "https://api.test/v1/messages")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)

    async def aiter_lines(self):
        for line in self.lines:
            if isinstance(line, Exception):
                raise line
            yield line


class FakeStreamCtx:

    def __init__(self, *, response=None, enter_exc=None):
        self.response = response
        self.enter_exc = enter_exc

    async def __aenter__(self):
        if self.enter_exc is not None:
            raise self.enter_exc
        return self.response

    async def __aexit__(self, *exc):
        return False


class FakeClient:
    def __init__(self, behaviors):
        self.behaviors = list(behaviors)
        self.calls = 0

    def stream(self, method, url, **kwargs):
        ctx = self.behaviors[self.calls]
        self.calls += 1
        return ctx


def text_event(text):
    return (
        'data: {"type": "content_block_delta", "delta": '
        f'{{"type": "text_delta", "text": "{text}"}}}}'
    )


class StreamSettings:
    llm_key = "k"
    llm_base_url = "https://api.test/v1/messages"


async def noop_sleep(seconds):
    return None


def patch_stream(monkeypatch, behaviors):
    client = FakeClient(behaviors)
    monkeypatch.setattr(llm, "get_settings", lambda: StreamSettings())
    monkeypatch.setattr(llm, "getClient", lambda: client)
    monkeypatch.setattr(llm.asyncio, "sleep", noop_sleep)  # keep retry backoff instant in tests
    return client


PAYLOAD = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 10}


class TestStreamChatRetries:

    async def test_connect_error_is_retried_then_succeeds(self, monkeypatch):
        ok = FakeStreamResponse(200, [text_event("hi"), ""])
        client = patch_stream(monkeypatch, [
            FakeStreamCtx(enter_exc=httpx.ConnectTimeout("no route")),
            FakeStreamCtx(response=ok),
        ])
        events = [e async for e in llm.streamChat(PAYLOAD, retries=2)]
        assert client.calls == 2
        assert events[0]["delta"]["text"] == "hi"

    async def test_429_before_stream_is_retried(self, monkeypatch):
        ok = FakeStreamResponse(200, [text_event("yo"), ""])
        client = patch_stream(monkeypatch, [
            FakeStreamCtx(response=FakeStreamResponse(429, [])),
            FakeStreamCtx(response=ok),
        ])
        events = [e async for e in llm.streamChat(PAYLOAD, retries=2)]
        assert client.calls == 2
        assert events[0]["delta"]["text"] == "yo"

    async def test_400_is_not_retried(self, monkeypatch):
        client = patch_stream(monkeypatch, [
            FakeStreamCtx(response=FakeStreamResponse(400, [])),
        ])
        with pytest.raises(httpx.HTTPStatusError):
            [e async for e in llm.streamChat(PAYLOAD, retries=2)]
        assert client.calls == 1

    async def test_failure_after_first_event_does_not_retry(self, monkeypatch):
        response = FakeStreamResponse(200, [text_event("a"), "", httpx.ReadError("dropped")])
        client = patch_stream(monkeypatch, [FakeStreamCtx(response=response)])
        events = []
        with pytest.raises(httpx.ReadError):
            async for e in llm.streamChat(PAYLOAD, retries=2):
                events.append(e)
        assert len(events) == 1
        assert client.calls == 1

    async def test_in_stream_error_event_raises(self, monkeypatch):
        lines = ['data: {"type": "error", "error": {"message": "overloaded"}}', ""]
        client = patch_stream(monkeypatch, [FakeStreamCtx(response=FakeStreamResponse(200, lines))])
        with pytest.raises(RuntimeError):
            [e async for e in llm.streamChat(PAYLOAD, retries=2)]
        assert client.calls == 1
