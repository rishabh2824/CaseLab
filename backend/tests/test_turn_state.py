"""Availability windows and per-persona chat (safety) state — pure, no I/O."""

import time

from services.simulation.turn_state import (
    NONSENSE_END_THRESHOLD,
    _build_boundary_reply,
    _chat_state_payload,
    _chat_state_payload_from_state,
    _elapsed_minutes,
    _format_run_histories,
    _get_persona_chat_state,
    _new_chat_state,
    _persona_chat_state_ref,
    persona_availability,
)


# --- persona_availability ---------------------------------------------------
class TestPersonaAvailability:
    def test_not_yet_available(self):
        result = persona_availability({"availability_duration": None}, available_at_minutes=10, elapsed_minutes=4)
        assert result == {"available": False, "available_in": 6, "expires_in": None}

    def test_available_exactly_at_open_boundary(self):
        # elapsed == available_at is the moment it opens: available, not still-waiting.
        result = persona_availability({"availability_duration": None}, available_at_minutes=10, elapsed_minutes=10)
        assert result["available"] is True
        assert result["available_in"] == 0

    def test_available_with_no_duration_never_expires(self):
        result = persona_availability({"availability_duration": None}, available_at_minutes=0, elapsed_minutes=99)
        assert result == {"available": True, "available_in": 0, "expires_in": None}

    def test_available_within_window_reports_remaining(self):
        # opens at 5, lasts 20 -> closes at 25; at minute 10, 15 left.
        result = persona_availability({"availability_duration": 20}, available_at_minutes=5, elapsed_minutes=10)
        assert result == {"available": True, "available_in": 0, "expires_in": 15}

    def test_available_on_final_minute_of_window(self):
        # opens at 0, lasts 30 -> closes at 30; elapsed == 30 is still available (uses >, not >=).
        result = persona_availability({"availability_duration": 30}, available_at_minutes=0, elapsed_minutes=30)
        assert result["available"] is True
        assert result["expires_in"] == 0

    def test_expired_after_window_closes(self):
        result = persona_availability({"availability_duration": 30}, available_at_minutes=0, elapsed_minutes=31)
        assert result == {"available": False, "available_in": None, "expires_in": 0}

    def test_missing_availability_duration_key_treated_as_no_limit(self):
        result = persona_availability({}, available_at_minutes=0, elapsed_minutes=5)
        assert result["available"] is True
        assert result["expires_in"] is None


# --- _elapsed_minutes -------------------------------------------------------
class TestElapsedMinutes:
    def test_floors_to_whole_minutes(self):
        run = {"start_time": time.time() - 125}  # 2m05s ago
        assert _elapsed_minutes(run) == 2

    def test_zero_at_start(self):
        run = {"start_time": time.time()}
        assert _elapsed_minutes(run) == 0


# --- chat (safety) state ----------------------------------------------------
class TestChatState:
    def test_new_chat_state_defaults(self):
        assert _new_chat_state() == {
            "warning_count": 0,
            "ended": False,
            "end_reason": None,
            "last_flag_type": None,
        }

    def test_get_is_a_pure_read_and_does_not_create_state(self):
        run = {}
        state = _get_persona_chat_state(run, "p1")
        assert state == _new_chat_state()
        # crucial: reading must NOT persist a key on the run (writes go through
        # _persona_chat_state_ref inside a mutate callback).
        assert "persona_chat_state" not in run

    def test_ref_creates_and_persists_state(self):
        run = {}
        ref = _persona_chat_state_ref(run, "p1")
        ref["warning_count"] = 2
        assert run["persona_chat_state"]["p1"]["warning_count"] == 2

    def test_ref_returns_same_object_on_second_call(self):
        run = {}
        first = _persona_chat_state_ref(run, "p1")
        first["ended"] = True
        second = _persona_chat_state_ref(run, "p1")
        assert second is first
        assert second["ended"] is True

    def test_payload_from_state_maps_fields(self):
        state = {"ended": True, "end_reason": "nonsense", "warning_count": 3, "last_flag_type": "nonsense"}
        assert _chat_state_payload_from_state(state) == {
            "chat_ended": True,
            "chat_end_reason": "nonsense",
            "warning_count": 3,
        }

    def test_payload_for_unflagged_persona(self):
        assert _chat_state_payload({}, "p1") == {
            "chat_ended": False,
            "chat_end_reason": None,
            "warning_count": 0,
        }


# --- _build_boundary_reply --------------------------------------------------
class TestBoundaryReply:
    def test_ending_reply_uses_persona_name(self):
        reply = _build_boundary_reply("Mary", should_end=True)
        assert reply.startswith("Mary is ending this conversation")

    def test_ending_reply_falls_back_to_I_when_name_empty(self):
        reply = _build_boundary_reply("", should_end=True)
        assert reply.startswith("I is ending this conversation")

    def test_warning_reply_is_generic(self):
        reply = _build_boundary_reply("Mary", should_end=False)
        assert "not able to follow that" in reply

    def test_threshold_is_three(self):
        assert NONSENSE_END_THRESHOLD == 3


# --- _format_run_histories --------------------------------------------------
class TestFormatRunHistories:
    def test_keeps_only_user_and_assistant_messages(self):
        run = {
            "history": {
                "p1": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "hello"},
                ]
            }
        }
        assert _format_run_histories(run) == {
            "p1": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
        }

    def test_filters_to_requested_persona_ids(self):
        run = {
            "history": {
                "p1": [{"role": "user", "content": "a"}],
                "p2": [{"role": "user", "content": "b"}],
            }
        }
        assert _format_run_histories(run, {"p1"}) == {"p1": [{"role": "user", "content": "a"}]}

    def test_missing_content_defaults_to_empty_string(self):
        run = {"history": {"p1": [{"role": "assistant"}]}}
        assert _format_run_histories(run) == {"p1": [{"role": "assistant", "content": ""}]}
