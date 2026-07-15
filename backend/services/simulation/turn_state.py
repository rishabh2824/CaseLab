"""Pure, no-I/O helpers over an in-memory run dict: availability windows and
per-persona chat (safety) state.
"""

import time

# classify_message_safety only distinguishes "normal" vs "nonsense" (the
# latter covers gibberish/spam as well as harassment/abuse) — one threshold
# for the one non-normal label.
NONSENSE_END_THRESHOLD = 3


def _elapsed_minutes(run) -> int:
    return int((time.time() - run["start_time"]) / 60)


def persona_availability(persona, available_at_minutes: int, elapsed_minutes: int):
    availability_duration = persona.get("availability_duration")
    available_at = available_at_minutes
    if elapsed_minutes < available_at:
        return {
            "available": False,
            "available_in": available_at - elapsed_minutes,
            "expires_in": None,
        }
    if availability_duration:
        expires_at = available_at + availability_duration
        if elapsed_minutes > expires_at:
            return {
                "available": False,
                "available_in": None,
                "expires_in": 0,
            }
        return {
            "available": True,
            "available_in": 0,
            "expires_in": max(0, expires_at - elapsed_minutes),
        }
    return {"available": True, "available_in": 0, "expires_in": None}


def _new_chat_state() -> dict:
    return {
        "warning_count": 0,
        "ended": False,
        "end_reason": None,
        "last_flag_type": None,
    }


def _get_persona_chat_state(run: dict, persona_id: str) -> dict:
    """Read a persona's chat (safety) state, or a fresh default if it has never
    been flagged. Pure read: it does NOT create state on the run — writes go
    through ``run_store.mutate`` + ``_persona_chat_state_ref`` (see
    prepare_message)."""
    return run.get("persona_chat_state", {}).get(persona_id) or _new_chat_state()


def _persona_chat_state_ref(run: dict, persona_id: str) -> dict:
    """Get-or-create the live, stored chat-state dict for a persona so it can be
    mutated. Only call this INSIDE a ``run_store.mutate`` callback — it writes to
    the run."""
    return run.setdefault("persona_chat_state", {}).setdefault(persona_id, _new_chat_state())


def _chat_state_payload_from_state(state: dict) -> dict:
    return {
        "chat_ended": state["ended"],
        "chat_end_reason": state["end_reason"],
        "warning_count": state["warning_count"],
    }


def _chat_state_payload(run: dict, persona_id: str) -> dict:
    return _chat_state_payload_from_state(_get_persona_chat_state(run, persona_id))


def _build_boundary_reply(persona_name: str, should_end: bool) -> str:
    name = persona_name or "I"
    if should_end:
        return (
            f"{name} is ending this conversation because the messages are not coherent or "
            "respectful enough to continue. Please send clear, respectful case-related "
            "questions to another contact."
        )
    return (
        "I am not able to follow that. Please send a clear, respectful, case-related "
        "question if you want to continue."
    )


def _format_run_histories(run: dict, persona_ids: set[str] | None = None) -> dict:
    histories = {}
    for persona_id, messages in run["history"].items():
        if persona_ids is not None and persona_id not in persona_ids:
            continue
        histories[persona_id] = [
            {
                "role": message.get("role"),
                "content": message.get("content", ""),
            }
            for message in messages
            if message.get("role") in {"user", "assistant"}
        ]
    return histories
