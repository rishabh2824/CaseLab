import re
import json
import logging

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_incrementing

from services import debug_log
from settings import get_settings

logger = logging.getLogger("caselab.llm")


def _headers(settings) -> dict:
    return {
        "x-api-key": settings.llm_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }


def _split_system(messages: list[dict]) -> tuple[str | list[dict] | None, list[dict]]:
    """Anthropic's native Messages API takes the system prompt as a separate
    top-level `system` param rather than a `role: "system"` message. Pull the
    first system message's content out of an OpenAI-shaped messages list and
    return it alongside the remaining user/assistant turns. `content` is
    passed through as-is, so the persona-reply system message's block-list
    shape (with its `cache_control` breakpoint) carries over unchanged --
    Anthropic's `system` field accepts either a plain string or that same
    block-list shape.
    """
    system = None
    rest = []
    for message in messages:
        if message.get("role") == "system" and system is None:
            system = message.get("content")
            continue
        rest.append(message)
    return system, rest


# Shared client so the 4-6 LLM calls a single student message can fan out to
# reuse one connection pool (keep-alive) instead of a fresh TLS handshake per
# call. Started/stopped from the FastAPI lifespan in main.py; falls back to a
# lazily-created client if used outside that lifespan (e.g. a script or test).
_client: httpx.AsyncClient | None = None


def init_client() -> None:
    global _client
    if _client is None:
        _client = httpx.AsyncClient()


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _get_client() -> httpx.AsyncClient:
    if _client is None:
        init_client()
    return _client


def _is_retryable(exc: Exception) -> bool:
    """Timeouts and rate-limit/server errors are worth retrying; other 4xx
    (bad request, auth, etc.) will fail identically every time, so don't burn
    attempts/backoff on them."""
    if isinstance(exc, (httpx.ReadTimeout, httpx.ConnectTimeout)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status == 429 or status >= 500
    return False


async def _chat(payload: dict, *, timeout: float, retries: int) -> dict:
    """POST an OpenAI-shaped chat payload (model/messages/temperature/
    max_tokens, with the system prompt as a `role: "system"` message) to
    Anthropic's Messages API and return the parsed JSON response body.

    Callers keep building payloads in the OpenAI-ish shape they always have;
    this function restructures them into Anthropic's native request (system
    prompt hoisted into a top-level `system` param) before sending, so call
    sites didn't need to change when the provider did.

    Retries retryable errors (timeouts, 429, 5xx) with linear backoff (1s, 2s,
    ...) via tenacity; other errors (e.g. a 400 for an unsupported parameter)
    raise immediately. Reraises the last error if every attempt fails; callers
    decide how to degrade.
    """
    settings = get_settings()
    if not settings.llm_key:
        raise RuntimeError("LLM_KEY is not configured.")
    headers = _headers(settings)
    client = _get_client()

    system, messages = _split_system(payload["messages"])
    anthropic_payload = {
        "model": payload["model"],
        "messages": messages,
        "max_tokens": payload["max_tokens"],
    }
    if system is not None:
        anthropic_payload["system"] = system
    if "temperature" in payload:
        anthropic_payload["temperature"] = payload["temperature"]
    # Structured outputs: when a caller supplies output_config, the API
    # constrains the response to that JSON schema. Used by the persona reply to
    # GUARANTEE the {reply, introduce, send_files} envelope shape (see
    # complete_persona_reply) — without it the model drifts out of JSON after a
    # few turns (its own prose replies in the conversation history are a
    # stronger signal than the system-prompt instruction), and the drifted
    # plain-text turns silently lose every referral/file decision.
    if "output_config" in payload:
        anthropic_payload["output_config"] = payload["output_config"]

    @retry(
        stop=stop_after_attempt(retries),
        wait=wait_incrementing(start=1, increment=1),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    )
    async def _send() -> dict:
        response = await client.post(
            settings.llm_base_url, json=anthropic_payload, headers=headers, timeout=timeout
        )
        response.raise_for_status()
        return response.json()

    return await _send()


def _message_content(data: dict) -> str:
    for block in data.get("content", []):
        if block.get("type") == "text":
            return block.get("text", "")
    return ""


# Schema the persona reply is CONSTRAINED to (structured outputs) so the model
# can't drop back to plain prose and silently zero out its referral/file
# decisions. Property descriptions restate the reply<->handle correlation the
# system prompt asks for, reinforcing it at the point the model fills each key.
_PERSONA_REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {
            "type": "string",
            "description": (
                "Your in-character reply as plain text, 1-3 concise sentences, "
                "with no speaker-name prefix and no surrounding quotes."
            ),
        },
        "introduce": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                'Contact handles (e.g. "R1") you are introducing in this reply. '
                "If your reply text introduces or connects the user to a contact, "
                "that contact's handle MUST appear here; otherwise []. Only use "
                "handles listed as available to you this turn."
            ),
        },
        "send_files": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                'File handles (e.g. "F1") you are sending with this reply, or []. '
                "If your reply text says you are sending/attaching a file, that "
                "file's handle MUST appear here. Only use handles listed as "
                "available to you this turn."
            ),
        },
    },
    "required": ["reply", "introduce", "send_files"],
    "additionalProperties": False,
}


async def complete_persona_reply(messages: list[dict]) -> str:
    """Generate the in-character persona turn on the primary (frontier) model
    and return the raw completion text.

    Unlike a streamed reply, this is buffered: the model returns a single JSON
    envelope (the reply text plus its own referral/file decisions), which the
    caller must receive in full before it can apply unlocks/shares and emit
    anything. Retries retryable failures (timeouts, 429, 5xx) via ``_chat``.
    """
    debug_log.persona_reply_input(messages)
    payload = {
        "model": get_settings().llm_model,
        "messages": messages,
        # No temperature: claude-sonnet-5 rejects non-default sampling
        # params (400 invalid_request_error) -- omit rather than send a
        # value it won't accept.
        "max_tokens": 600,
        # Force the {reply, introduce, send_files} envelope at the API level so
        # the model can't drift back to plain prose (which silently drops every
        # unlock/share decision — see _chat / _PERSONA_REPLY_SCHEMA).
        "output_config": {
            "format": {"type": "json_schema", "schema": _PERSONA_REPLY_SCHEMA}
        },
    }
    data = await _chat(payload, timeout=90, retries=3)
    # Usage carries the prompt-cache breakdown (cache_creation_input_tokens /
    # cache_read_input_tokens); logged at DEBUG so cache hit rates can be
    # checked without production noise.
    usage = data.get("usage")
    if usage:
        logger.debug("persona reply usage: %s", usage)
    raw = _message_content(data)
    debug_log.persona_reply_output(raw)
    return raw


def _format_transcript(conversation: list[dict]) -> tuple[str, int, int]:
    """Render a conversation as a plain transcript plus user/assistant counts.

    Shared by the referral and file-share judges so they see identical input.
    """
    lines = []
    user_count = 0
    assistant_count = 0
    for message in conversation:
        role = message.get("role")
        if role == "system":
            continue
        lines.append(f"{role}: {message.get('content', '')}")
        if role == "user":
            user_count += 1
        elif role == "assistant":
            assistant_count += 1
    transcript = "\n".join(lines) if lines else "No conversation yet."
    return transcript, user_count, assistant_count


async def _yes_no_judge(
    system_prompt: str, user_prompt: str, *, debug_label: str | None = None
) -> bool:
    """Run a strict YES/NO classifier on the cheap model.

    Raises on request failure instead of failing closed -- a broken judge call
    now aborts the turn with a user-facing error (see prepare_message's
    try/except around _resolve_turn_decisions) rather than silently deciding
    "no unlock/share" and letting the turn proceed as if nothing were wrong.

    ``debug_label`` opts into raw-output tracing (see debug_log.judge_output)
    — only classify_referral passes one; classify_file_share doesn't, so its
    output is never traced, per debug_log's module docstring.
    """
    settings = get_settings()
    payload = {
        "model": settings.llm_classifier_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0,
        "max_tokens": 10,
    }
    data = await _chat(payload, timeout=60, retries=3)
    raw = _message_content(data)
    result = raw.strip().upper().startswith("YES")
    if debug_label:
        debug_log.judge_output(debug_label, raw, result)
    return result


# Referral-unlock and file-share are the same YES/NO judge shape — they only
# differ in what action is being gated and how the condition is labeled.
_CONDITION_KINDS = {
    "referral": {
        "action": "UNLOCK A NEW CONTACT (a referral)",
        "condition_noun": "referral's unlock condition",
        "condition_label": "Referral unlock condition",
    },
    "file_share": {
        "action": "SHARE A FILE with the user",
        "condition_noun": "file's sharing condition",
        "condition_label": "File sharing condition",
    },
}


async def _classify_condition(kind: str, condition: str, conversation: list[dict]) -> bool:
    spec = _CONDITION_KINDS[kind]
    transcript, user_count, assistant_count = _format_transcript(conversation)
    system_prompt = (
        f"You are a strict classifier deciding whether to {spec['action']} in a case "
        f"simulation. Determine if the {spec['condition_noun']} is satisfied given the "
        "conversation. Use common sense and the overall intent, not exact wording. "
        "Reply with ONLY 'YES' or 'NO'."
    )
    user_prompt = (
        f"{spec['condition_label']}:\n{condition}\n\n"
        f"Conversation (most recent last):\n{transcript}\n\n"
        f"Conversation stats: user_messages={user_count}, assistant_messages={assistant_count}"
    )
    if kind == "file_share":
        # Position-only marker — classify_file_share's own input/output is
        # intentionally not traced (see debug_log's module docstring).
        debug_log.marker("classify_file_share")
        return await _yes_no_judge(system_prompt, user_prompt)
    debug_log.judge_input("classify_referral", condition, transcript)
    return await _yes_no_judge(system_prompt, user_prompt, debug_label="classify_referral")


async def classify_referral(condition: str, conversation: list[dict]) -> bool:
    """Decide whether a referral's unlock condition is satisfied. Cheap model."""
    return await _classify_condition("referral", condition, conversation)


async def classify_file_share(condition: str, conversation: list[dict]) -> bool:
    """Decide whether a file's sharing condition is satisfied. Cheap model."""
    return await _classify_condition("file_share", condition, conversation)


def _looks_like_nonsense(message: str) -> bool:
    cleaned = (message or "").strip()
    if not cleaned:
        return True
    normalized = re.sub(r"\s+", " ", cleaned.lower())
    tokens = [token for token in re.split(r"\s+", normalized) if token]
    alnum_chars = [char for char in normalized if char.isalnum()]

    if len(normalized) >= 12 and len(alnum_chars) / max(len(normalized), 1) < 0.35:
        return True
    if re.fullmatch(r"(.)\1{7,}", normalized):
        return True
    if len(tokens) >= 4 and len(set(tokens)) == 1:
        return True
    return False


async def classify_message_safety(user_message: str, conversation: list[dict]) -> str:
    """Safety label for the latest user message: "normal" or "nonsense"."""
    debug_log.marker("classify_message_safety")
    if _looks_like_nonsense(user_message):
        return "nonsense"

    settings = get_settings()
    transcript = "\n".join(
        f"{msg.get('role')}: {msg.get('content', '')}"
        for msg in conversation[-6:]
        if msg.get("role") != "system"
    )
    if not transcript:
        transcript = "No prior conversation."

    payload = {
        "model": settings.llm_classifier_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a strict conversation safety classifier for a case simulation. "
                    "Classify the latest user message in context. "
                    "Return ONLY one label from this set: NORMAL, NONSENSE.\n"
                    "Use NONSENSE for spam, gibberish, or repeatedly incoherent case-irrelevant "
                    "input, AND for rude, insulting, harassing, or abusive messages, including "
                    "explicit threats or severe abuse — anything that isn't a normal, coherent, "
                    "case-related message.\n"
                    "Otherwise return NORMAL."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Recent conversation:\n{transcript}\n\n"
                    f"Latest user message:\n{user_message}"
                ),
            },
        ],
        "temperature": 0,
        "max_tokens": 10,
    }
    try:
        data = await _chat(payload, timeout=30, retries=2)
    except Exception:
        return "normal"
    label = _message_content(data).strip().upper()
    if label.startswith("NONSENSE"):
        return "nonsense"
    return "normal"
