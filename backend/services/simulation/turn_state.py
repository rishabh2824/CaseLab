import time


# Number of nonsense messages allowed before ending the chat
NONSENSE_THRESHOLD = 3


def elapsedMinutes(run) -> int:
    return int((time.time() - run["start_time"]) / 60)


# Computes if a persona should be currently reachable or not.
def personaAvailability(persona, available_at_minutes: int, elapsed_minutes: int):
    availability_duration = persona.get("availability_duration")
    available_at = available_at_minutes
    if elapsed_minutes < available_at:
        return {
            "available": False,
            "available_in": available_at - elapsed_minutes,
            "expires_in": None,
        }
    if availability_duration is not None:
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


def newChatState() -> dict:
    return {
        "warning_count": 0,
        "ended": False,
        "end_reason": None,
        "last_flag_type": None,
    }


# Gets the chat state for one persona
def getChatState(run: dict, persona_id: str) -> dict:
    return run.get("persona_chat_state", {}).get(persona_id) or newChatState()


# Same but this is an editable version
def editChatState(run: dict, persona_id: str) -> dict:
    return run.setdefault("persona_chat_state", {}).setdefault(persona_id, newChatState())


# drops fields from the dict not needed by frontend
def shapeChatState(state: dict) -> dict:
    return {
        "chat_ended": state["ended"],
        "chat_end_reason": state["end_reason"],
        "warning_count": state["warning_count"],
    }


# Final thing sent to the frontend
def chatStatePayload(run: dict, persona_id: str) -> dict:
    return shapeChatState(getChatState(run, persona_id))


# Persona response to a nonsense message.
def boundaryReply(persona_name: str, should_end: bool) -> str:
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


# takes the run's full history dict and returns only user/assistant turns, trimmed to {role, content}
def formatHistory(run: dict, persona_ids: set[str] | None = None) -> dict:
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
