import re
import json
import asyncio

import httpx

from settings import get_settings


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


async def _chat(payload: dict, *, timeout: float, retries: int) -> dict:
    """POST a chat-completions payload and return the parsed JSON response body.

    Retries on connection/timeout/HTTP errors with linear backoff. Raises the
    last error if every attempt fails; callers decide how to degrade.
    """
    settings = get_settings()
    if not settings.llm_key:
        raise RuntimeError("LLM_KEY is not configured.")
    headers = _headers(settings)
    client = _get_client()
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = await client.post(
                settings.llm_base_url, json=payload, headers=headers, timeout=timeout
            )
            response.raise_for_status()
            return response.json()
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.HTTPStatusError) as exc:
            last_error = exc
            if attempt < retries - 1:
                await asyncio.sleep(1 + attempt)
    raise last_error or RuntimeError("LLM request failed.")


def _message_content(data: dict) -> str:
    return data["choices"][0]["message"]["content"]


def _extract_json(text: str) -> dict | None:
    cleaned = re.sub(r"^\s*```json\s*|\s*```\s*$", "", text.strip(), flags=re.IGNORECASE)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return None
    return None


async def chat_completion_structured(messages: list[dict]) -> dict:
    """Main in-character persona reply. Uses the primary (frontier) model."""
    settings = get_settings()
    if settings.sim_debug:
        print("LLM DEBUG: request ->", [m["role"] for m in messages])
    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": 0.6,
        "max_tokens": 300,
    }
    data = await _chat(payload, timeout=90, retries=3)
    content = _message_content(data)
    if settings.sim_debug:
        print("LLM DEBUG: raw response ->", content)
    parsed = _extract_json(content)
    if not isinstance(parsed, dict):
        # One retry with a stricter instruction (now also resilient via _chat).
        strict_messages = messages + [
            {
                "role": "system",
                "content": "Return ONLY valid JSON with a single key: reply. No extra text.",
            }
        ]
        strict_payload = {**payload, "messages": strict_messages}
        data = await _chat(strict_payload, timeout=90, retries=3)
        content = _message_content(data)
        if settings.sim_debug:
            print("LLM DEBUG: raw retry response ->", content)
        parsed = _extract_json(content)
    if not isinstance(parsed, dict):
        parsed = {"reply": content}
    if settings.sim_debug:
        print("LLM DEBUG: parsed ->", parsed)
    reply = parsed.get("reply", "")
    # Strip leading bracketed speaker tags like "[Mary, CFO ...]"
    reply = re.sub(r"^\s*\[[^\]]+\]\s*", "", reply).strip()
    reply = re.sub(r"^\s*```json\s*|\s*```\s*$", "", reply, flags=re.IGNORECASE).strip()
    return {"reply": reply}


async def classify_referral(condition: str, conversation: list[dict]) -> bool:
    """YES/NO judge for a referral condition. Uses the cheaper classifier model."""
    settings = get_settings()
    transcript_lines = []
    user_count = 0
    assistant_count = 0
    for message in conversation:
        role = message.get("role")
        if role == "system":
            continue
        content = message.get("content", "")
        transcript_lines.append(f"{role}: {content}")
        if role == "user":
            user_count += 1
        if role == "assistant":
            assistant_count += 1
    transcript = "\n".join(transcript_lines) if transcript_lines else "No conversation yet."
    payload = {
        "model": settings.llm_classifier_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a strict classifier. Determine if the referral condition is satisfied "
                    "given the conversation. Use common sense and the overall intent, not exact wording. "
                    "Reply with ONLY 'YES' or 'NO'."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Referral condition:\n{condition}\n\n"
                    f"Conversation (most recent last):\n{transcript}\n\n"
                    f"Conversation stats: user_messages={user_count}, assistant_messages={assistant_count}"
                ),
            },
        ],
        "temperature": 0,
    }
    try:
        data = await _chat(payload, timeout=60, retries=3)
    except Exception:
        return False
    answer = _message_content(data).strip().upper()
    return answer.startswith("YES")


async def classify_condition(condition: str, conversation: list[dict]) -> bool:
    return await classify_referral(condition, conversation)


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
    """Safety label for the latest user message. Uses the classifier model."""
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
                    "Return ONLY one label from this set: NORMAL, NONSENSE, HARASSMENT, SEVERE_ABUSE.\n"
                    "Use NONSENSE for spam, gibberish, or repeatedly incoherent case-irrelevant input.\n"
                    "Use HARASSMENT for rude, insulting, or abusive behavior that is not an extreme threat.\n"
                    "Use SEVERE_ABUSE for explicit threats, severe harassment, or clearly intolerable abuse.\n"
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
    if label.startswith("SEVERE_ABUSE"):
        return "severe_abuse"
    if label.startswith("HARASSMENT"):
        return "harassment"
    if label.startswith("NONSENSE"):
        return "nonsense"
    return "normal"


async def generate_contact_introduction(
    persona_details: dict,
    newly_unlocked: list[dict],
    recent_conversation: list[dict],
) -> str:
    """One short in-character intro sentence. Uses the cheaper classifier model."""
    settings = get_settings()
    names_and_roles = ", ".join(
        f"{persona['name']} ({persona['role']})" for persona in newly_unlocked
    )
    transcript = "\n".join(
        f"{msg['role']}: {msg['content']}"
        for msg in recent_conversation
        if msg.get("role") != "system"
    )
    payload = {
        "model": settings.llm_classifier_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    f"You are {persona_details['name']}, {persona_details['role']}. "
                    "Write one short, natural sentence introducing colleagues to the consultant. "
                    "Stay in character. Be brief. Do not repeat prior sentences."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Recent conversation:\n{transcript}\n\n"
                    f"Introduce these contacts naturally: {names_and_roles}. "
                    "One sentence only."
                ),
            },
        ],
        "temperature": 0.6,
        "max_tokens": 80,
    }
    try:
        data = await _chat(payload, timeout=30, retries=2)
        return _message_content(data).strip()
    except Exception:
        pass
    return " ".join(
        f"I'd like to connect you with {persona['name']}, our {persona['role']}."
        for persona in newly_unlocked
    )
