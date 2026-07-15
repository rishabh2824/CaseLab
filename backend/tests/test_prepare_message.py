"""prepare_message: the classifier-failure path has no fallback (unlike
classifyHarassment's silent "normal" default) — a referral/file-eligibility
judge failing after retries must fail the whole message with a clear
resend-it message, not guess at what the persona is allowed to reveal.
"""

import time

import pytest
from fastapi import HTTPException

from models.simulations import SendMessagePayload
from Queries.simulation import runs as runs_module
from services.simulation import service


def _seed_run(run_id: str):
    run = {
        "case_id": "c1",
        "case_snapshot": {"simulation_duration": None},
        "persona_graph": {
            "root_personas": [{"id": "p1", "name": "Mary", "role": "CFO", "availability_duration": None}],
            "referrals": [],
        },
        "start_time": time.time(),
        "active_persona_id": "p1",
        "unlocked_referred_ids": set(),
        "unlocked_at": {},
        "shared_files": {},
        "history": {},
        "persona_chat_state": {},
        "notes": "",
    }
    return run


@pytest.fixture(autouse=True)
def _wire_fake_db(monkeypatch, fake_client):
    monkeypatch.setattr(runs_module, "getDb", lambda: fake_client)
    monkeypatch.setattr(service, "getDb", lambda: fake_client)
    # Rate limiting isn't what this test exercises, and FakeClient doesn't
    # implement the rate_limits table's SQL shape — skip it outright.
    monkeypatch.setattr(service, "messageLimit", lambda run_id: _noop())


async def _noop():
    return None


class TestClassifierFailureHasNoFallback:
    async def test_referral_classifier_failure_raises_502_asking_to_resend(self, monkeypatch):
        await service.run_store.put("r1", _seed_run("r1"))

        async def ok_harassment(*a, **kw):
            return "normal"

        async def failing_resolve_turn_decisions(*a, **kw):
            raise RuntimeError("classifier timed out")

        monkeypatch.setattr(service, "classifyHarassment", ok_harassment)
        monkeypatch.setattr(service, "resolve_turn_decisions", failing_resolve_turn_decisions)

        with pytest.raises(HTTPException) as exc_info:
            await service.prepare_message("r1", SendMessagePayload(persona_id="p1", message="Hello there"))

        assert exc_info.value.status_code == 502
        assert "resend" in exc_info.value.detail.lower()

    async def test_user_turn_is_still_recorded_even_though_the_message_fails(self, monkeypatch):
        # The user's own turn is written before classification runs (same
        # ordering as the reload-resilience fix) — a classifier hiccup must not
        # silently drop what the user actually typed.
        await service.run_store.put("r1", _seed_run("r1"))

        async def failing_resolve_turn_decisions(*a, **kw):
            raise RuntimeError("boom")

        monkeypatch.setattr(service, "classifyHarassment", lambda *a, **kw: _returns("normal"))
        monkeypatch.setattr(service, "resolve_turn_decisions", failing_resolve_turn_decisions)

        with pytest.raises(HTTPException):
            await service.prepare_message("r1", SendMessagePayload(persona_id="p1", message="Hello there"))

        run = await service.run_store.get("r1")
        assert run["history"]["p1"] == [{"role": "user", "content": "Hello there"}]


async def _returns(value):
    return value
