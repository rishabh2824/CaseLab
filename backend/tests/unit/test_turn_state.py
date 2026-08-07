"""services/simulation/turn_state.py — pure state-shaping helpers.

No DB, no LLM, no network: every function here is a straightforward
transform over a Run/PersonaDetail/ChatState, which is exactly what makes the
personaAvailability boundary and the getChatState/editChatState mutation
contract worth pinning down with unit tests instead of only exercising them
indirectly through a full turn.
"""

from __future__ import annotations

from hypothesis import given, strategies as st

from models.runtime import ChatState
from models.simulations import ChatMessage
from services.simulation import turn_state
from tests import factories


def personaDetail(availability_duration=None):
    return turn_state.PersonaDetail(id="A", name="A", role="Role", availability_duration=availability_duration)


# --------------------------------------------------------------------------
# personaAvailability
# --------------------------------------------------------------------------


def test_persona_availability_not_yet_available():
    # elapsed (5) < available_at (10): still waiting.
    persona = personaDetail(availability_duration=None)
    result = turn_state.personaAvailability(persona, 10, 5)
    assert result == {"available": False, "available_in": 5, "expires_in": None}


def test_persona_availability_no_duration_never_expires():
    # No availability_duration set at all -> available forever once reached.
    persona = personaDetail(availability_duration=None)
    result = turn_state.personaAvailability(persona, 10, 50)
    assert result == {"available": True, "available_in": 0, "expires_in": None}


def test_persona_availability_with_duration_remaining():
    # available_at=10, duration=20 -> expires_at=30. elapsed=15 leaves 15 left.
    persona = personaDetail(availability_duration=20)
    result = turn_state.personaAvailability(persona, 10, 15)
    assert result == {"available": True, "available_in": 0, "expires_in": 15}


def test_persona_availability_exactly_at_expiry_boundary_is_still_available():
    # The code checks `elapsed_minutes > expires_at`, not `>=`, so landing
    # exactly on the boundary (elapsed == expires_at) is still available,
    # just with zero time left. This is the boundary the task calls out.
    persona = personaDetail(availability_duration=20)
    result = turn_state.personaAvailability(persona, 10, 30)
    assert result == {"available": True, "available_in": 0, "expires_in": 0}


def test_persona_availability_past_expiry_is_expired():
    # One minute past the boundary flips to expired.
    persona = personaDetail(availability_duration=20)
    result = turn_state.personaAvailability(persona, 10, 31)
    assert result == {"available": False, "available_in": None, "expires_in": 0}


def test_persona_availability_zero_duration_expires_immediately():
    # availability_duration=0 means "available for zero minutes": the persona
    # is available for the instant it becomes reachable and expired from then
    # on, distinct from availability_duration=None (available forever).
    persona = personaDetail(availability_duration=0)
    result = turn_state.personaAvailability(persona, 10, 1000)
    assert result == {"available": False, "available_in": None, "expires_in": 0}


def test_persona_availability_zero_duration_at_available_at_is_available_for_the_instant():
    # elapsed == available_at == expires_at: still within the (zero-width)
    # window, so it reports available with zero time left, not expired.
    persona = personaDetail(availability_duration=0)
    result = turn_state.personaAvailability(persona, 10, 10)
    assert result == {"available": True, "available_in": 0, "expires_in": 0}


@given(
    available_at=st.integers(min_value=0, max_value=500),
    duration=st.one_of(st.none(), st.integers(min_value=0, max_value=500)),
    elapsed=st.integers(min_value=0, max_value=1000),
)
def test_persona_availability_invariants_always_hold(available_at, duration, elapsed):
    persona = personaDetail(availability_duration=duration)
    result = turn_state.personaAvailability(persona, available_at, elapsed)

    # available_in/expires_in are either None or non-negative, never negative.
    assert result["available_in"] is None or result["available_in"] >= 0
    assert result["expires_in"] is None or result["expires_in"] >= 0
    # If the persona is available right now, there is by definition no wait left.
    if result["available"]:
        assert result["available_in"] == 0
    # available and available_in==0 are the same fact told two ways: not
    # available always carries a strictly positive available_in OR None
    # (expired case reports available_in=None, not 0).
    if not result["available"]:
        assert result["available_in"] is None or result["available_in"] > 0


# --------------------------------------------------------------------------
# newChatState / getChatState / editChatState
# --------------------------------------------------------------------------


def test_new_chat_state_shape():
    assert turn_state.newChatState() == ChatState(warning_count=0, ended=False, end_reason=None, last_flag_type=None)


def test_get_chat_state_does_not_mutate_run_when_missing():
    run = factories.run()
    state = turn_state.getChatState(run, "A")
    assert state == turn_state.newChatState()
    # Reading state for a persona that has none yet must not create the key —
    # only editChatState is allowed to do that.
    assert run.persona_chat_state == {}


def test_get_chat_state_returns_a_fresh_default_every_time_when_absent():
    run = factories.run()
    state = turn_state.getChatState(run, "A")
    state.warning_count = 99  # mutate the returned object
    # Since getChatState never stored it anywhere, a second read is unaffected.
    again = turn_state.getChatState(run, "A")
    assert again.warning_count == 0


def test_get_chat_state_reads_existing_state_without_copying_semantics_surprise():
    run = factories.run(persona_chat_state={"A": ChatState(warning_count=2, ended=False, end_reason=None, last_flag_type=None)})
    state = turn_state.getChatState(run, "A")
    assert state.warning_count == 2


def test_edit_chat_state_mutates_the_run():
    run = factories.run()
    state = turn_state.editChatState(run, "A")
    assert run.persona_chat_state["A"] is state


def test_edit_chat_state_is_idempotent_on_repeat_calls():
    run = factories.run()
    first = turn_state.editChatState(run, "A")
    first.warning_count = 3
    first.ended = True
    second = turn_state.editChatState(run, "A")
    # Same object, and the earlier mutation survived — a repeat call must not
    # reset state back to newChatState()'s defaults.
    assert second is first
    assert second.warning_count == 3
    assert second.ended is True


# --------------------------------------------------------------------------
# shapeChatState / chatStatePayload
# --------------------------------------------------------------------------


def test_shape_chat_state_exposes_only_the_three_browser_facing_keys():
    state = turn_state.newChatState()
    state.last_flag_type = "nonsense"  # internal-only field
    shaped = turn_state.shapeChatState(state)
    assert set(shaped.keys()) == {"chat_ended", "chat_end_reason", "warning_count"}
    assert "last_flag_type" not in shaped


def test_chat_state_payload_matches_shape_chat_state_for_existing_persona():
    run = factories.run(
        persona_chat_state={"A": ChatState(warning_count=1, ended=True, end_reason="nonsense", last_flag_type="nonsense")}
    )
    payload = turn_state.chatStatePayload(run, "A")
    assert payload == {"chat_ended": True, "chat_end_reason": "nonsense", "warning_count": 1}


def test_chat_state_payload_defaults_for_unknown_persona():
    payload = turn_state.chatStatePayload(factories.run(), "unknown")
    assert payload == {"chat_ended": False, "chat_end_reason": None, "warning_count": 0}


# --------------------------------------------------------------------------
# boundaryReply
# --------------------------------------------------------------------------


def test_boundary_reply_ending_mentions_the_persona_by_name():
    reply = turn_state.boundaryReply("Mary", True)
    assert reply.startswith("Mary is ending this conversation")


def test_boundary_reply_non_ending_is_a_fixed_warning_regardless_of_name():
    reply = turn_state.boundaryReply("Mary", False)
    assert reply == (
        "I am not able to follow that. Please send a clear, respectful, case-related "
        "question if you want to continue."
    )


def test_boundary_reply_empty_name_falls_back_to_i():
    # `name = persona_name or "I"` — an empty/falsy name becomes "I" so the
    # ending message never renders with a blank subject.
    reply = turn_state.boundaryReply("", True)
    assert reply.startswith("I is ending this conversation")


# --------------------------------------------------------------------------
# formatHistory
# --------------------------------------------------------------------------


def test_format_history_trims_to_role_and_content():
    run = factories.run(
        history={"A": [ChatMessage(role="user", content="hi"), ChatMessage(role="assistant", content="hello")]}
    )
    result = turn_state.formatHistory(run)
    assert result == {"A": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]}


def test_format_history_honours_persona_ids_filter():
    run = factories.run(
        history={
            "A": [ChatMessage(role="user", content="a-msg")],
            "B": [ChatMessage(role="user", content="b-msg")],
        }
    )
    result = turn_state.formatHistory(run, persona_ids={"A"})
    assert set(result.keys()) == {"A"}


# --------------------------------------------------------------------------
# elapsedMinutes
# --------------------------------------------------------------------------


def test_elapsed_minutes_floors_to_whole_minutes(monkeypatch):
    monkeypatch.setattr(turn_state.time, "time", lambda: 1_000_000.0)
    # 90 seconds elapsed = 1.5 minutes -> floors to 1, not rounds to 2.
    run = factories.run(start_time=1_000_000.0 - 90)
    assert turn_state.elapsedMinutes(run) == 1


def test_elapsed_minutes_exact_multiple(monkeypatch):
    monkeypatch.setattr(turn_state.time, "time", lambda: 1_000_000.0)
    run = factories.run(start_time=1_000_000.0 - 120)
    assert turn_state.elapsedMinutes(run) == 2
