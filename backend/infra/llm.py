import httpx
from openai import AsyncOpenAI, APIConnectionError, APITimeoutError, RateLimitError, InternalServerError
from infra.settings import getSettings, LLM_ATTEMPT_TIMEOUT, LLM_CLASSIFIER_TIMEOUT, PERSONA_REPLY_RETRIES

# Shared client so the 4-6 LLM calls a single student message can fan out to reuse one connection pool
client: AsyncOpenAI | None = None
CLIENT_LIMITS = httpx.Limits(max_connections=1000, max_keepalive_connections=200)


def initClient() -> None:
    global client
    if client is None:
        settings = getSettings()
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
    *, model: str, messages: list[dict], max_tokens: int, timeout: float, temperature: float | None = None,
) -> str:
    if client is None: raise RuntimeError("LLM client failed to initialize.")
    kwargs = {"model": model, "messages": messages, "max_tokens": max_tokens, "timeout": timeout}
    if temperature is not None: kwargs["temperature"] = temperature
    # Every caller of chat() is a temperature=0 classification gate (referral/file-share/
    # harassment) — pin routing to Anthropic directly so identical inputs aren't put through
    # whatever upstream OpenRouter happens to pick for a given request.
    kwargs["extra_body"] = {"provider": {"order": ["anthropic"], "allow_fallbacks": False}}
    response = await client.chat.completions.create(**kwargs)
    return response.choices[0].message.content or ""


# Schema the persona reply is constrained to (structured outputs). reply/introduce/send_files
# are generated as ONE schema-constrained JSON object — the provider's constrained decoding
# guarantees introduce/send_files are always present and consistent with the same generation
# that produced reply, unlike an optional, separately-decided tool call that the model can
# simply skip or contradict.
#
# Descriptions here are deliberately terse field labels, not the full contract — replyInstructions()
# (services/simulation/prompt.py) already states the full contract — required keys, the handle
# format, the "introduce"/"send_files" agreement rule — inside the system prompt text. Restating
# all of that here would just be the same prose paid again.
PERSONA_REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string", "description": "In-character reply text."},
        "introduce": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Contact handles introduced in this reply.",
        },
        "send_files": {
            "type": "array",
            "items": {"type": "string"},
            "description": "File handles sent with this reply.",
        },
    },
    "required": ["reply", "introduce", "send_files"],
    "additionalProperties": False,
}


# Only these errors are worth retrying
RETRYABLE_EXCEPTIONS = (APIConnectionError, APITimeoutError, RateLimitError, InternalServerError)


# Streaming persona reply. Yields {"type": "delta", "text": ...} for each raw fragment of the
# schema-constrained JSON object as it streams. The caller (services/simulation/stream.py)
# incrementally extracts just the "reply" field for the live preview (see ReplyExtractor in
# services/simulation/reply_stream.py), then authoritatively parses the full accumulated text
# once the stream ends — the live preview is best-effort, the final parse is the reply of record.
async def personaReplyStream(messages: list[dict]):
    if client is None: raise RuntimeError("LLM client failed to initialize.")
    settings = getSettings()
    retries = PERSONA_REPLY_RETRIES

    attempt = 0
    while True:
        attempt += 1
        yielded_any = False
        try:
            stream = await client.chat.completions.create(
                model=settings.llm_model,
                messages=messages,
                max_tokens=600,
                response_format={
                    "type": "json_schema",
                    "json_schema": {"name": "persona_reply", "strict": True, "schema": PERSONA_REPLY_SCHEMA},
                },
                stream=True,
                timeout=LLM_ATTEMPT_TIMEOUT,
                # Same provider pin as chat() (classifiers): route to Anthropic directly
                # so identical inputs aren't put through whatever upstream OpenRouter
                # happens to pick for a given request.
                extra_body={"provider": {"order": ["anthropic"], "allow_fallbacks": False}},
            )
            async for chunk in stream:
                if not chunk.choices: continue
                delta = chunk.choices[0].delta
                if delta.content:
                    yielded_any = True
                    yield {"type": "delta", "text": delta.content}
            return
        except Exception as exc:
            if not yielded_any and attempt < retries and isinstance(exc, RETRYABLE_EXCEPTIONS):
                continue
            raise


# Share the last few messages only instead of the full chat history
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
    settings = getSettings()
    raw = await chat(
        model=settings.llm_classifier_model,
        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
        temperature=0,
        max_tokens=10,
        timeout=LLM_CLASSIFIER_TIMEOUT,
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
        "The condition text may also include a note on how to phrase things once acted "
        "on (e.g. \"when you refer/share, mention/explain...\") — that is guidance "
        "for the persona's future reply, NOT an additional requirement, and must NOT be "
        "treated as something that has to already appear in the conversation. Judge "
        "only whether the actual trigger has been met.\n"
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
    settings = getSettings()
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
            timeout=LLM_ATTEMPT_TIMEOUT,
        )
    except Exception:
        # Fail OPEN, deliberately: a classifier outage (timeout, upstream error)
        # must not itself block a student from continuing their case. The cost of
        # under-flagging one message during an outage is low; the cost of a wave
        # of "please resend" errors for every student mid-simulation is not.
        # Contrast with referralUnlock/fileShare (services/simulation/prompt.py),
        # which fail CLOSED (propagate) — there, an outage silently deciding
        # "don't unlock"/"don't share" is the wrong default because it can hide
        # content the case design says the student should have gotten, with no
        # signal to the student or case author that anything went wrong.
        return "normal"
    label = raw.strip().upper()
    if label.startswith("NONSENSE"): return "nonsense"
    return "normal"
