"""services/simulation/prompt.py — prompt assembly and the redaction/handle
parsing logic that keeps a persona from leaking a locked-away contact.

referralUnlock/fileShare are tested by stubbing classifyReferral/classifyFileShare
directly on this module's namespace (monkeypatch), per the task instructions —
NOT via the `sim` fixture, which belongs to another test file.
"""

from __future__ import annotations

from services.simulation import prompt as prompt_module


CASE_SNAPSHOT = {
    "initial_brief": "Reduce office supply costs.",
    "common_information": "Sterling Industries background.",
}


def personaDetails(**overrides) -> dict:
    base = dict(
        name="Mary",
        role="CFO",
        personality_traits="Direct, impatient",
        known_facts="Karen handles all complaint escalations.",
    )
    base.update(overrides)
    return base


# --------------------------------------------------------------------------
# systemPrompt
# --------------------------------------------------------------------------


def test_system_prompt_returns_a_stable_turn_pair():
    stable, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert isinstance(stable, str)
    assert isinstance(turn, str)


def test_system_prompt_stable_half_carries_case_and_persona_facts():
    stable, _ = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "Reduce office supply costs." in stable
    assert "Sterling Industries background." in stable
    assert "Mary" in stable
    assert "CFO" in stable
    assert "Direct, impatient" in stable
    assert "Karen handles all complaint escalations." in stable


def test_system_prompt_turn_half_carries_referral_and_file_sections():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[{"handle": "R1", "name": "Bob", "role": "COO"}],
        eligible_files=[{"handle": "F1", "name": "Budget.pdf", "perceived_contents": "last quarter's numbers"}],
        withheld_file_names=[],
    )
    assert "Referrals:" in turn
    assert "Files:" in turn
    assert "R1: Bob (COO)" in turn
    assert "F1: Budget.pdf (what you believe it contains: last quarter's numbers)" in turn


def test_system_prompt_lists_each_eligible_referral_handle():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[
            {"handle": "R1", "name": "Bob", "role": "COO"},
            {"handle": "R2", "name": "Sue", "role": "CTO"},
        ],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "You MAY introduce" in turn
    assert "R1: Bob (COO)" in turn
    assert "R2: Sue (CTO)" in turn


def test_system_prompt_no_referrals_branch_when_eligible_referrals_empty():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "You have no one to introduce this turn." in turn
    assert "You MAY introduce" not in turn


def test_system_prompt_files_no_perceived_contents_omits_parenthetical():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[],
        eligible_files=[{"handle": "F2", "name": "Empty.pdf", "perceived_contents": ""}],
        withheld_file_names=[],
    )
    assert "F2: Empty.pdf" in turn
    assert "F2: Empty.pdf (what you believe" not in turn


def test_system_prompt_no_files_branch_when_eligible_files_empty():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "You have no file to send this turn." in turn
    assert "You MAY send" not in turn


def test_system_prompt_withheld_file_names_sentence_present_when_given():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=["Secret.pdf"],
    )
    assert "You possess but must NOT send or offer the following file(s): Secret.pdf." in turn


def test_system_prompt_withheld_file_names_sentence_absent_when_empty():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=[],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "must NOT send or offer" not in turn


def test_system_prompt_forbidden_referrals_add_the_never_mention_sentence():
    _, turn = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(),
        forbidden_referral_names=["Karen"],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "Never mention, introduce, or offer to connect the user" in turn


# --------------------------------------------------------------------------
# redaction — security critical
# --------------------------------------------------------------------------


def test_system_prompt_redacts_forbidden_name_from_known_facts():
    stable, _ = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(known_facts="Karen handles all complaint escalations."),
        forbidden_referral_names=["Karen"],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "Karen" not in stable
    assert "[undisclosed contact]" in stable


def test_system_prompt_redaction_is_word_boundary_based():
    # "Ann" is a substring of "Anna" — it must NOT redact into the middle of a
    # longer word ("Anna" must stay intact, not become "[undisclosed contact]a").
    stable, _ = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(known_facts="Anna is the CFO."),
        forbidden_referral_names=["Ann"],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "Anna is the CFO." in stable
    assert "[undisclosed contact]" not in stable


def test_system_prompt_redaction_escapes_regex_metacharacters():
    # A name containing regex metacharacters must be treated literally, not
    # crash, and not over-match.
    stable, _ = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(known_facts="Reach out to J. Smith for approvals."),
        forbidden_referral_names=["J. Smith"],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    assert "J. Smith" not in stable
    assert "Reach out to [undisclosed contact] for approvals." in stable


def test_system_prompt_redaction_skips_blank_and_whitespace_names():
    stable, _ = prompt_module.systemPrompt(
        CASE_SNAPSHOT,
        personaDetails(known_facts="Karen handles all complaint escalations."),
        forbidden_referral_names=["", "   ", "Karen"],
        eligible_referrals=[],
        eligible_files=[],
        withheld_file_names=[],
    )
    # Must not raise on the blank entries, and must still redact the real one.
    assert "[undisclosed contact]" in stable


# --------------------------------------------------------------------------
# sanitizeHistory
# --------------------------------------------------------------------------


def test_sanitize_history_rewrites_locked_names_in_assistant_turns_only():
    history = [
        {"role": "user", "content": "Is Bob available?"},
        {"role": "assistant", "content": "Bob is not available. Ask Bob later."},
    ]
    result = prompt_module.sanitizeHistory(history, ["Bob"])
    assert result[0]["content"] == "Is Bob available?"  # user turn untouched
    assert result[1]["content"] == "my contact is not available. Ask my contact later."


def test_sanitize_history_returns_input_unchanged_when_no_locked_names():
    history = [{"role": "assistant", "content": "Bob said hi."}]
    result = prompt_module.sanitizeHistory(history, [])
    assert result is history


def test_sanitize_history_does_not_mutate_the_callers_list():
    history = [{"role": "assistant", "content": "Bob is around."}]
    result = prompt_module.sanitizeHistory(history, ["Bob"])
    assert result is not history
    assert history[0]["content"] == "Bob is around."  # original untouched


# --------------------------------------------------------------------------
# parseReply / jsonExtractor
# --------------------------------------------------------------------------


def test_parse_reply_clean_json_object():
    raw = '{"reply": "Hi there.", "introduce": ["R1"], "send_files": []}'
    assert prompt_module.parseReply(raw) == {"reply": "Hi there.", "introduce": ["R1"], "send_files": []}


def test_parse_reply_strips_code_fence():
    raw = '```json\n{"reply": "Hi.", "introduce": [], "send_files": []}\n```'
    assert prompt_module.parseReply(raw) == {"reply": "Hi.", "introduce": [], "send_files": []}


def test_parse_reply_extracts_json_object_from_surrounding_prose():
    raw = 'Sure, here it is: {"reply": "Hi.", "introduce": [], "send_files": []} thanks'
    assert prompt_module.parseReply(raw) == {"reply": "Hi.", "introduce": [], "send_files": []}


def test_parse_reply_empty_or_none_returns_none():
    assert prompt_module.parseReply("") is None
    assert prompt_module.parseReply(None) is None


def test_parse_reply_unparseable_text_returns_none():
    assert prompt_module.parseReply("not json at all") is None


def test_parse_reply_json_array_is_not_a_dict_returns_none():
    assert prompt_module.parseReply("[1, 2, 3]") is None


# --------------------------------------------------------------------------
# coerceHandles
# --------------------------------------------------------------------------


def test_coerce_handles_upper_cases_and_strips():
    assert prompt_module.coerceHandles(["r1", " R2 "]) == ["R1", "R2"]


def test_coerce_handles_drops_whitespace_only_entries():
    assert prompt_module.coerceHandles(["   ", "r1"]) == ["R1"]


def test_coerce_handles_bare_string_is_treated_as_single_item_list():
    assert prompt_module.coerceHandles("R1") == ["R1"]


def test_coerce_handles_non_list_non_string_returns_empty():
    assert prompt_module.coerceHandles(5) == []
    assert prompt_module.coerceHandles(None) == []


def test_coerce_handles_non_string_non_int_items_are_skipped():
    assert prompt_module.coerceHandles(["R1", None, ["nested"], 2]) == ["R1", "2"]


# --------------------------------------------------------------------------
# cleanReply
# --------------------------------------------------------------------------


def test_clean_reply_strips_leading_speaker_tag():
    assert prompt_module.cleanReply("[Mary, CFO] Hello there.") == "Hello there."


def test_clean_reply_leaves_inline_bracket_untouched():
    text = "Sure thing. [Note: confidential] Okay."
    assert prompt_module.cleanReply(text) == text


def test_clean_reply_handles_empty_and_none():
    assert prompt_module.cleanReply(None) == ""
    assert prompt_module.cleanReply("") == ""
    assert prompt_module.cleanReply("   ") == ""


# --------------------------------------------------------------------------
# referralUnlock / fileShare
# --------------------------------------------------------------------------


async def test_referral_unlock_false_without_calling_classifier_when_condition_blank(monkeypatch):
    async def failIfCalled(condition, history):
        raise AssertionError("classifyReferral should not have been called")

    monkeypatch.setattr(prompt_module, "classifyReferral", failIfCalled)
    result = await prompt_module.referralUnlock({"condition_trigger": "   "}, [])
    assert result is False


async def test_referral_unlock_calls_classifier_with_stripped_condition(monkeypatch):
    calls = []

    async def stub(condition, history):
        calls.append((condition, history))
        return True

    monkeypatch.setattr(prompt_module, "classifyReferral", stub)
    history = [{"role": "user", "content": "hi"}]
    result = await prompt_module.referralUnlock({"condition_trigger": "  asks about budget  "}, history)
    assert result is True
    assert calls == [("asks about budget", history)]


async def test_file_share_false_without_calling_classifier_when_share_conditions_missing(monkeypatch):
    async def failIfCalled(condition, history):
        raise AssertionError("classifyFileShare should not have been called")

    monkeypatch.setattr(prompt_module, "classifyFileShare", failIfCalled)
    # share_conditions key absent entirely — must fall back to "" via .get(...).
    result = await prompt_module.fileShare({}, [])
    assert result is False


async def test_file_share_false_without_calling_classifier_when_blank(monkeypatch):
    async def failIfCalled(condition, history):
        raise AssertionError("classifyFileShare should not have been called")

    monkeypatch.setattr(prompt_module, "classifyFileShare", failIfCalled)
    result = await prompt_module.fileShare({"share_conditions": "   "}, [])
    assert result is False


async def test_file_share_calls_classifier_when_condition_present(monkeypatch):
    async def stub(condition, history):
        assert condition == "asks about the budget"
        return False

    monkeypatch.setattr(prompt_module, "classifyFileShare", stub)
    result = await prompt_module.fileShare({"share_conditions": "asks about the budget"}, [])
    assert result is False
