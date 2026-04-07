import re
import json
import asyncio
import httpx

from app.core.settings import get_settings


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
    settings = get_settings()
    if not settings.llm_key:
        raise RuntimeError("LLM_KEY is not configured.")
    if settings.sim_debug:
        print("LLM DEBUG: request ->", [m["role"] for m in messages])
    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": 0.6,
        "max_tokens": 300,
    }
    headers = {
        "Authorization": f"Bearer {settings.llm_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://caselab.local",
        "X-Title": "caseLab",
    }
    last_error = None
    async with httpx.AsyncClient(timeout=90) as client:
        for attempt in range(3):
            try:
                response = await client.post(
                    settings.llm_base_url, json=payload, headers=headers
                )
                response.raise_for_status()
                data = response.json()
                break
            except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.HTTPStatusError) as exc:
                last_error = exc
                await asyncio.sleep(1 + attempt)
        else:
            raise last_error or RuntimeError("LLM timeout.")
    content = data["choices"][0]["message"]["content"]
    if settings.sim_debug:
        print("LLM DEBUG: raw response ->", content)
    parsed = _extract_json(content)
    if not isinstance(parsed, dict):
        # One retry with a stricter instruction
        strict_messages = messages + [
            {
                "role": "system",
                "content": "Return ONLY valid JSON with a single key: reply. No extra text.",
            }
        ]
        payload["messages"] = strict_messages
        async with httpx.AsyncClient(timeout=90) as retry_client:
            response = await retry_client.post(
                settings.llm_base_url, json=payload, headers=headers
            )
            response.raise_for_status()
            data = response.json()
        content = data["choices"][0]["message"]["content"]
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
        "model": settings.llm_model,
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
    headers = {
        "Authorization": f"Bearer {settings.llm_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://caselab.local",
        "X-Title": "caseLab",
    }
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(3):
            try:
                response = await client.post(
                    settings.llm_base_url, json=payload, headers=headers
                )
                response.raise_for_status()
                data = response.json()
                answer = data["choices"][0]["message"]["content"].strip().upper()
                return answer.startswith("YES")
            except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.HTTPStatusError):
                if attempt == 2:
                    return False
                await asyncio.sleep(1 + attempt)
    return False


async def classify_condition(condition: str, conversation: list[dict]) -> bool:
    return await classify_referral(condition, conversation)


async def generate_contact_introduction(
    persona_details: dict,
    newly_unlocked: list[dict],
    recent_conversation: list[dict],
) -> str:
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
        "model": settings.llm_model,
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
    headers = {
        "Authorization": f"Bearer {settings.llm_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://caselab.local",
        "X-Title": "caseLab",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        for attempt in range(2):
            try:
                response = await client.post(
                    settings.llm_base_url, json=payload, headers=headers
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"].strip()
            except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.HTTPStatusError):
                if attempt == 1:
                    break
                await asyncio.sleep(1 + attempt)
    return " ".join(
        f"I'd like to connect you with {persona['name']}, our {persona['role']}."
        for persona in newly_unlocked
    )
