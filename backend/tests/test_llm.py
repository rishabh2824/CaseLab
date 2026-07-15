"""Timeout/retry budgets for the LLM call sites, and classifyHarassment's
fallback behavior (the one intentional exception to "no default on failure").
"""

import pytest

from infra import llm


class TestCallBudgets:
    """personaReply and yesNoJudge intentionally have NO fallback on failure —
    a message that can't be generated/classified fails outright rather than
    guessing, so these budgets directly bound how long a user waits before
    seeing an error. Kept short on purpose (see conversation: these used to be
    90s/3 tries and 60s/3 tries, which stacked into multi-minute worst cases).
    """

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
        await llm.yesNoJudge("system prompt", "user prompt")
        assert captured == {"timeout": 20, "retries": 2}

    async def test_yes_no_judge_failure_propagates_with_no_fallback(self, monkeypatch):
        async def failing_chat(payload, *, timeout, retries):
            raise RuntimeError("boom")

        monkeypatch.setattr(llm, "chat", failing_chat)
        with pytest.raises(RuntimeError):
            await llm.yesNoJudge("system prompt", "user prompt")


class TestClassifyHarassmentFallback:
    """The one classifier that DOES have a silent default — unaffected by the
    yesNoJudge budget change above, since it makes its own chat() call."""

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
