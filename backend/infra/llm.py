import json
import httpx
from openai import AsyncOpenAI, APIConnectionError, APITimeoutError, RateLimitError, InternalServerError
from infra.settings import get_settings

# Shared client so the 4-6 LLM calls a single student message can fan out to reuse one connection pool
client: AsyncOpenAI | None = None
CLIENT_LIMITS = httpx.Limits(max_connections=1000, max_keepalive_connections=200)


def initClient() -> None:
    global client
    if client is None:
        settings = get_settings()
        client = AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_key,
            max_retries=2,
            http_client=httpx.AsyncClient(limits=CLIENT_LIMITS),
        )


async def closeClient() -> None:
    global client
    if client is not None:
        await client.close()
        client = None


# Call the chat completions endpoint and return the reply text.
async def chat(
    *, model: str, messages: list[dict], max_tokens: int, timeout: float, temperature: float | None = None
) -> str:
    if client is None: raise RuntimeError("LLM client failed to initialize.")
    kwargs = {"model": model, "messages": messages, "max_tokens": max_tokens, "timeout": timeout}
    if temperature is not None: kwargs["temperature"] = temperature
    response = await client.chat.completions.create(**kwargs)
    return response.choices[0].message.content or ""


# Tool the persona reply call uses to report contacts/files touched this turn — the reply
# itself is plain streamed text now (see personaReplyStream), not part of any schema.
REPLY_METADATA_TOOL = {
    "type": "function",
    "function": {
        "name": "report_reply_metadata",
        "description": "Report which contacts you introduced and which files you sent in this reply.",
        "parameters": {
            "type": "object",
            "properties": {
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
            "required": ["introduce", "send_files"],
            "additionalProperties": False,
        },
    },
}


# Only connection/timeout/rate-limit/server errors are worth retrying
RETRYABLE_EXCEPTIONS = (APIConnectionError, APITimeoutError, RateLimitError, InternalServerError)


# Streaming persona reply. Yields {"type": "delta", "text": ...} for each fragment of the
# in-character reply as it streams, then one final {"type": "tool_call", "arguments": ...}
# once the stream ends ("arguments" is None if the model never called the tool, or if its
# arguments were truncated mid-generation and failed to parse as JSON).
async def personaReplyStream(messages: list[dict]):
    if client is None: raise RuntimeError("LLM client failed to initialize.")
    settings = get_settings()
    retries = 2

    attempt = 0
    while True:
        attempt += 1
        yielded_any = False
        tool_call_parts: dict[int, str] = {}
        try:
            stream = await client.chat.completions.create(
                model=settings.llm_model,
                messages=messages,
                max_tokens=600,
                tools=[REPLY_METADATA_TOOL],
                tool_choice="auto",
                stream=True,
                timeout=30,
            )
            async for chunk in stream:
                if not chunk.choices: continue
                delta = chunk.choices[0].delta
                if delta.content:
                    yielded_any = True
                    yield {"type": "delta", "text": delta.content}
                if delta.tool_calls:
                    for tool_call_delta in delta.tool_calls:
                        fragment = (tool_call_delta.function.arguments if tool_call_delta.function else None) or ""
                        tool_call_parts[tool_call_delta.index] = tool_call_parts.get(tool_call_delta.index, "") + fragment

            arguments = None
            if tool_call_parts:
                raw_arguments = "".join(tool_call_parts[i] for i in sorted(tool_call_parts))
                try:
                    arguments = json.loads(raw_arguments)
                except json.JSONDecodeError:
                    arguments = None
            yield {"type": "tool_call", "arguments": arguments}
            return
        except Exception as exc:
            if not yielded_any and attempt < retries and isinstance(exc, RETRYABLE_EXCEPTIONS):
                continue
            raise


# Shared "last N turns" window for every classifier prompt (harassment + referral/file
# conditions) — one number, so batching them into a single call later doesn't require
# reconciling mismatched windows.
CLASSIFIER_HISTORY_LIMIT = 8


# Formats the last `limit` non-system turns of a conversation as "role: content" lines
def formatTranscript(conversation: list[dict], limit: int = CLASSIFIER_HISTORY_LIMIT) -> tuple[str, int, int]:
    lines = []
    user_count = 0
    assistant_count = 0
    for message in conversation[-limit:]:
        role = message.get("role")
        if role == "system": continue
        lines.append(f"{role}: {message.get('content', '')}")
        if role == "user": user_count += 1
        elif role == "assistant": assistant_count += 1
    transcript = "\n".join(lines) if lines else "No conversation yet."
    return transcript, user_count, assistant_count


# YES / NO Classifier for below methods
async def classifier(system_prompt: str, user_prompt: str) -> bool:
    settings = get_settings()
    raw = await chat(
        model=settings.llm_classifier_model,
        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
        temperature=0,
        max_tokens=10,
        timeout=20,
    )
    return raw.strip().upper().startswith("YES")


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
    return await classifier(system_prompt, user_prompt)


async def classifyReferral(condition: str, conversation: list[dict]) -> bool:
    return await classifyCondition("referral", condition, conversation)


async def classifyFileShare(condition: str, conversation: list[dict]) -> bool:
    return await classifyCondition("file_share", condition, conversation)


async def classifyHarassment(user_message: str, conversation: list[dict]) -> str:
    settings = get_settings()
    transcript, _, _ = formatTranscript(conversation)

    system_prompt = (
        "You are a strict conversation safety classifier for a case simulation. "
        "Classify the latest user message in context. "
        "Return ONLY one label from this set: NORMAL, NONSENSE.\n"
        "Use NONSENSE for spam, gibberish, or repeatedly incoherent case-irrelevant "
        "input, AND for rude, insulting, harassing, or abusive messages, including "
        "explicit threats or severe abuse — anything that isn't a normal, coherent, "
        "case-related message.\n"
        "Otherwise return NORMAL."
    )
    user_prompt = f"Recent conversation:\n{transcript}\n\nLatest user message:\n{user_message}"

    try:
        raw = await chat(
            model=settings.llm_classifier_model,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            temperature=0,
            max_tokens=10,
            timeout=30,
        )
    except Exception: return "normal"
    label = raw.strip().upper()
    if label.startswith("NONSENSE"): return "nonsense"
    return "normal"
