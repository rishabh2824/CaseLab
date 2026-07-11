"""Terminal tracing for the student message pipeline, gated behind
settings.debug (CASELAB_DEBUG=1) — a no-op otherwise, so there's zero output
or overhead in normal operation.

Scope is deliberately narrow: full raw/cleaned input-output tracing only for
classify_referral and complete_persona_reply (services/llm.py), the two calls
that actually decide what the persona says and does. classify_message_safety
and classify_file_share only get a one-line "happens here" marker at their
position in the sequence — see llm.py for where each is called from.

Each log_* function builds its block as one string and makes a single
print() call, so concurrent classify_referral/classify_file_share calls (one
per pending referral/file, run via asyncio.gather) don't interleave mid-block.
"""

from settings import get_settings

_RULE = "=" * 88


def enabled() -> bool:
    return get_settings().debug


def user_message(persona_id: str, message: str) -> None:
    if not enabled():
        return
    print(f"\n{_RULE}\nUSER MESSAGE -> persona {persona_id}\n  {message}\n{_RULE}")


def marker(step: str) -> None:
    """The one-line, position-only marker for classify_message_safety /
    classify_file_share — their own input/output is intentionally not traced."""
    if not enabled():
        return
    print(f"  -> {step} workflow happens here")


def judge_input(label: str, condition: str, transcript: str) -> None:
    if not enabled():
        return
    transcript_lines = "\n".join(f"       {line}" for line in transcript.splitlines())
    print(
        f"\n  -> {label}: input\n"
        f"     condition: {condition}\n"
        f"     transcript sent:\n{transcript_lines}"
    )


def judge_output(label: str, raw_output: str, result: bool) -> None:
    if not enabled():
        return
    print(f"     {label}: output\n       raw: {raw_output!r}\n       parsed result: {result}")


# Texts of cached system blocks already printed in full this process. The cached
# block (persona facts + reply-format instructions) is identical across a
# persona's turns, so printing it every message buries the parts that actually
# change. We print it once, then abbreviate — keyed by the block text so a
# different persona's (different) system prompt still prints once on its own.
_printed_system_texts: set[str] = set()


def _format_messages(messages: list[dict]) -> str:
    lines = []
    for msg in messages:
        role = msg.get("role", "?")
        content = msg.get("content")
        if isinstance(content, list):
            lines.append(f"  [{role}]")
            for block in content:
                text = block.get("text", "")
                if block.get("cache_control"):
                    if text in _printed_system_texts:
                        lines.append(
                            "    - (cached) [system prompt unchanged - printed above]"
                        )
                    else:
                        _printed_system_texts.add(text)
                        lines.append(f"    - (cached) {text}")
                else:
                    # The uncached turn block (referral/file eligibility) changes
                    # every turn, so always print it in full.
                    lines.append(f"    - {text}")
        else:
            lines.append(f"  [{role}] {content}")
    return "\n".join(lines)


def persona_reply_input(messages: list[dict]) -> None:
    if not enabled():
        return
    print("\n  -> complete_persona_reply: input\n" + _format_messages(messages))


def persona_reply_output(raw_output: str) -> None:
    if not enabled():
        return
    print(f"     complete_persona_reply: raw output\n       {raw_output!r}")


def persona_reply_cleaned(reply: str, introduce: list[str], send_files: list[str]) -> None:
    if not enabled():
        return
    print(
        "     complete_persona_reply: cleaned\n"
        f"       reply sent to user: {reply!r}\n"
        f"       envelope claimed -> introduce={introduce}, send_files={send_files}"
    )


def applied_outcome(
    claimed_contacts: list[str],
    applied_contacts: list[str],
    claimed_files: list[str],
    applied_files: list[str],
) -> None:
    """The last step: what the envelope claimed vs. what was actually
    unlocked/shared. A mismatch here is the "persona says but doesn't do"
    bug — an invalid/stale handle, or a malformed envelope that fell back to
    the zero-unlock path."""
    if not enabled():
        return
    mismatch = sorted(claimed_contacts) != sorted(applied_contacts) or sorted(
        claimed_files
    ) != sorted(applied_files)
    flag = "  <-- MISMATCH (claimed but not applied, or vice versa)" if mismatch else ""
    print(
        f"     ACTUALLY applied -> unlocked={applied_contacts}, shared={applied_files}{flag}\n"
        f"{_RULE}"
    )
