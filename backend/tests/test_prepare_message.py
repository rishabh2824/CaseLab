
import time
import uuid

import pytest
from fastapi import HTTPException

from models.simulations import SendMessagePayload
from services.simulation import service
from services.simulation.run_store import insertRun, getRun


def run_id() -> str:
    return f"test-{uuid.uuid4().hex}"


def seed_run():
    return {
        "case_id": "c1",
        "case_snapshot": {"simulation_duration": None},
        "persona_graph": {
            "root_personas": [
                {
                    "id": "p1",
                    "name": "Mary",
                    "role": "CFO",
                    "availability_duration": None,
                    "known_facts": None,
                    "personality_traits": None,
                    "profile_photo": None,
                    "files": [],
                }
            ],
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


@pytest.fixture(autouse=True)
def wire_fake_rate_limit(monkeypatch, db_session):
    # Rate limiting isn't what this test exercises.
    monkeypatch.setattr(service, "messageLimit", lambda run_id: noop())


async def noop():
    return None


class TestClassifierFailureHasNoFallback:
    async def test_referral_classifier_failure_raises_502_asking_to_resend(self, monkeypatch):
        rid = run_id()
        await insertRun(rid, seed_run())

        async def ok_harassment(*a, **kw):
            return "normal"

        async def failing_resolve_turn_decisions(*a, **kw):
            raise RuntimeError("classifier timed out")

        monkeypatch.setattr(service, "classifyHarassment", ok_harassment)
        monkeypatch.setattr(service, "resolve_turn_decisions", failing_resolve_turn_decisions)

        with pytest.raises(HTTPException) as exc_info:
            await service.message(rid, SendMessagePayload(persona_id="p1", message="Hello there"))

        assert exc_info.value.status_code == 502
        assert "resend" in exc_info.value.detail.lower()

    async def test_user_turn_is_still_recorded_even_though_the_message_fails(self, monkeypatch):
        # The user's own turn is written before classification runs (same
        # ordering as the reload-resilience fix) — a classifier hiccup must not
        # silently drop what the user actually typed.
        rid = run_id()
        await insertRun(rid, seed_run())

        async def failing_resolve_turn_decisions(*a, **kw):
            raise RuntimeError("boom")

        monkeypatch.setattr(service, "classifyHarassment", lambda *a, **kw: returns("normal"))
        monkeypatch.setattr(service, "resolve_turn_decisions", failing_resolve_turn_decisions)

        with pytest.raises(HTTPException):
            await service.message(rid, SendMessagePayload(persona_id="p1", message="Hello there"))

        run = await getRun(rid)
        assert run["history"]["p1"] == [{"role": "user", "content": "Hello there"}]


async def returns(value):
    return value
