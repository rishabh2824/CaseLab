import re
import json
import logging

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_incrementing

from settings import get_settings

logger = logging.getLogger("caselab.llm")


def _headers(settings) -> dict:
    return {
        "Authorization": f"Bearer {settings.llm_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://caselab.local",
        "X-Title": "caseLab",
    }


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
    """POST a chat-completions payload and return the parsed JSON response body.

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

    @retry(
        stop=stop_after_attempt(retries),
        wait=wait_incrementing(start=1, increment=1),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    )
    async def _send() -> dict:
        response = await client.post(
            settings.llm_base_url, json=payload, headers=headers, timeout=timeout
        )
        response.raise_for_status()
        return response.json()

    return await _send()


def _message_content(data: dict) -> str:
    return data["choices"][0]["message"]["content"]


async def complete_persona_reply(messages: list[dict]) -> str:
    """Generate the in-character persona turn on the primary (frontier) model
    and return the raw completion text.

    Unlike a streamed reply, this is buffered: the model returns a single JSON
    envelope (the reply text plus its own referral/file decisions), which the
    caller must receive in full before it can apply unlocks/shares and emit
    anything. Retries retryable failures (timeouts, 429, 5xx) via ``_chat``.
    """
    payload = {
        "model": get_settings().llm_model,
        "messages": messages,
        "temperature": 0.6,
        "max_tokens": 600,
    }
    data = await _chat(payload, timeout=90, retries=3)
    # Usage carries the prompt-cache breakdown (cache_creation vs cache_read
    # input tokens, or OpenRouter's prompt_tokens_details.cached_tokens); logged
    # at DEBUG so cache hit rates can be checked without production noise.
    usage = data.get("usage")
    if usage:
        logger.debug("persona reply usage: %s", usage)
    return _message_content(data)


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


async def _yes_no_judge(system_prompt: str, user_prompt: str) -> bool:
    """Run a strict YES/NO classifier on the cheap model. Fails closed (False)
    on any error, since these gate unlocking content the user shouldn't get by
    default."""
    settings = get_settings()
    payload = {
        "model": settings.llm_classifier_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0,
    }
    try:
        data = await _chat(payload, timeout=60, retries=3)
    except Exception:
        return False
    return _message_content(data).strip().upper().startswith("YES")


async def classify_referral(condition: str, conversation: list[dict]) -> bool:
    """Decide whether a referral's unlock condition is satisfied. Cheap model."""
    transcript, user_count, assistant_count = _format_transcript(conversation)
    system_prompt = (
        "You are a strict classifier deciding whether to UNLOCK A NEW CONTACT (a "
        "referral) in a case simulation. Determine if the referral's unlock condition "
        "is satisfied given the conversation. Use common sense and the overall intent, "
        "not exact wording. Reply with ONLY 'YES' or 'NO'."
    )
    user_prompt = (
        f"Referral unlock condition:\n{condition}\n\n"
        f"Conversation (most recent last):\n{transcript}\n\n"
        f"Conversation stats: user_messages={user_count}, assistant_messages={assistant_count}"
    )
    return await _yes_no_judge(system_prompt, user_prompt)


async def classify_file_share(condition: str, conversation: list[dict]) -> bool:
    """Decide whether a file's sharing condition is satisfied. Cheap model."""
    transcript, user_count, assistant_count = _format_transcript(conversation)
    system_prompt = (
        "You are a strict classifier deciding whether to SHARE A FILE with the user in "
        "a case simulation. Determine if the file's sharing condition is satisfied given "
        "the conversation. Use common sense and the overall intent, not exact wording. "
        "Reply with ONLY 'YES' or 'NO'."
    )
    user_prompt = (
        f"File sharing condition:\n{condition}\n\n"
        f"Conversation (most recent last):\n{transcript}\n\n"
        f"Conversation stats: user_messages={user_count}, assistant_messages={assistant_count}"
    )
    return await _yes_no_judge(system_prompt, user_prompt)


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
    """Safety label for the latest user message: "normal" or "nonsense".
    "nonsense" is deliberately broad — it covers gibberish/spam as well as
    rude, harassing, or abusive messages. There's no separate immediate-end
    tier; repeated nonsense (of any kind) ends the chat via the warning-count
    threshold in prepare_message, rather than some messages ending it
    instantly and others only warning."""
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
