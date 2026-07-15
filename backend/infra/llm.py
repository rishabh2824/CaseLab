import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_incrementing
from infra.settings import get_settings


def headers(settings) -> dict:
    return {"x-api-key": settings.llm_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}


# Shared client so the 4-6 LLM calls a single student message can fan out to reuse one connection pool
_client: httpx.AsyncClient | None = None
_CLIENT_LIMITS = httpx.Limits(max_connections=1000, max_keepalive_connections=200)


def initClient() -> None:
    global _client
    if _client is None: _client = httpx.AsyncClient(limits=_CLIENT_LIMITS)


async def closeClient() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def getClient() -> httpx.AsyncClient | None:
    if _client is None: initClient()
    return _client


# Only Timeouts and rate-limit/server errors are worth retrying
def isRetryable(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.ReadTimeout, httpx.ConnectTimeout)): return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status == 429 or status >= 500
    return False


# POST a payload to Anthropic's Messages API and return the parsed JSON response body.
async def chat(payload: dict, *, timeout: float, retries: int) -> dict:
    settings = get_settings()
    header = headers(settings)
    client = getClient()

    anthropic_payload = {
        "model": payload["model"], "messages": payload["messages"], "max_tokens": payload["max_tokens"]
    }
    if "system" in payload: anthropic_payload["system"] = payload["system"]
    if "temperature" in payload: anthropic_payload["temperature"] = payload["temperature"]

    # Structured outputs: Used by the persona reply to GUARANTEE the {reply, introduce, send_files} envelope shape
    if "output_config" in payload: anthropic_payload["output_config"] = payload["output_config"]

    @retry(
        stop=stop_after_attempt(retries),
        wait=wait_incrementing(start=1, increment=1),
        retry=retry_if_exception(isRetryable),
        reraise=True,
    )
    async def send() -> dict:
        if client is None: raise RuntimeError("HTTP client failed to initialize.")
        response = await client.post(settings.llm_base_url, json=anthropic_payload, headers=header, timeout=timeout)
        response.raise_for_status()
        return response.json()

    return await send()


# Extracts the raw message from API Response
def messageContent(data: dict) -> str:
    for block in data.get("content", []):
        if block.get("type") == "text": return block.get("text", "")
    return ""


# Schema the persona reply is CONSTRAINED to (structured outputs)
PERSONA_REPLY_SCHEMA = {
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


# Generates the persona's response to user message
async def personaReply(system: str | list[dict], messages: list[dict]) -> str:
    payload = {
        "model": get_settings().llm_model,
        "system": system,
        "messages": messages,
        "max_tokens": 600,
        "output_config": {"format": {"type": "json_schema", "schema": PERSONA_REPLY_SCHEMA}}
    }
    data = await chat(payload, timeout=30, retries=2)
    raw = messageContent(data)
    return raw


# Formats the message transcript
def formatTranscript(conversation: list[dict]) -> tuple[str, int, int]:
    lines = []
    user_count = 0
    assistant_count = 0
    for message in conversation:
        role = message.get("role")
        if role == "system": continue
        lines.append(f"{role}: {message.get('content', '')}")
        if role == "user": user_count += 1
        elif role == "assistant": assistant_count += 1
    transcript = "\n".join(lines) if lines else "No conversation yet."
    return transcript, user_count, assistant_count


# YES / NO Classifier for below methods
async def yesNoJudge(system_prompt: str, user_prompt: str) -> bool:
    settings = get_settings()
    payload = {
        "model": settings.llm_classifier_model,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
        "temperature": 0,
        "max_tokens": 10,
    }
    data = await chat(payload, timeout=20, retries=2)
    raw = messageContent(data)
    result = raw.strip().upper().startswith("YES")
    return result


CONDITION_KINDS = {
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


# Helper for classify referral and file share
async def classifyCondition(kind: str, condition: str, conversation: list[dict]) -> bool:
    spec = CONDITION_KINDS[kind]
    transcript, user_count, assistant_count = formatTranscript(conversation)
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
    return await yesNoJudge(system_prompt, user_prompt)


async def classifyReferral(condition: str, conversation: list[dict]) -> bool:
    return await classifyCondition("referral", condition, conversation)


async def classifyFileShare(condition: str, conversation: list[dict]) -> bool:
    return await classifyCondition("file_share", condition, conversation)


async def classifyHarassment(user_message: str, conversation: list[dict]) -> str:
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
        "system": (
            "You are a strict conversation safety classifier for a case simulation. "
            "Classify the latest user message in context. "
            "Return ONLY one label from this set: NORMAL, NONSENSE.\n"
            "Use NONSENSE for spam, gibberish, or repeatedly incoherent case-irrelevant "
            "input, AND for rude, insulting, harassing, or abusive messages, including "
            "explicit threats or severe abuse — anything that isn't a normal, coherent, "
            "case-related message.\n"
            "Otherwise return NORMAL."
        ),
        "messages": [
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
        data = await chat(payload, timeout=30, retries=2)
    except Exception: return "normal"
    label = messageContent(data).strip().upper()
    if label.startswith("NONSENSE"): return "nonsense"
    return "normal"
