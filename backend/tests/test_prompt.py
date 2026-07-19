
import pytest

from services.simulation.prompt import (
    systemPrompt,
    cleanReply,
    coerceHandles,
    jsonExtractor,
    parseReply,
    sanitizeHistory,
)


# --- parse_reply / first_json_object ---------------------------------------
class TestParseReply:
    def test_plain_json_object(self):
        assert parseReply('{"reply": "hi", "introduce": [], "send_files": []}') == {
            "reply": "hi",
            "introduce": [],
            "send_files": [],
        }

    def test_strips_json_code_fence(self):
        raw = '```json\n{"reply": "hi", "introduce": [], "send_files": []}\n```'
        assert parseReply(raw)["reply"] == "hi"

    def test_strips_bare_code_fence(self):
        raw = '```\n{"reply": "yo"}\n```'
        assert parseReply(raw) == {"reply": "yo"}

    def test_extracts_object_from_surrounding_prose(self):
        raw = 'Sure! {"reply": "hi", "introduce": []} hope that helps'
        assert parseReply(raw)["reply"] == "hi"

    def test_none_on_empty(self):
        assert parseReply("") is None
        assert parseReply("   ") is None

    def test_none_on_non_json(self):
        assert parseReply("just some text with no object") is None

    def test_none_when_top_level_is_a_list(self):
        # a JSON array is valid JSON but not the {reply,...} envelope shape.
        assert parseReply("[1, 2, 3]") is None

    def test_first_json_object_bounds(self):
        assert jsonExtractor('x {"a": 1} y') == '{"a": 1}'
        assert jsonExtractor("no braces") is None
        assert jsonExtractor("}{") is None  # end before start


# --- coerce_handles ---------------------------------------------------------
class TestCoerceHandles:
    def test_uppercases_and_trims(self):
        assert coerceHandles([" r1 ", "f2"]) == ["R1", "F2"]

    def test_wraps_bare_string(self):
        assert coerceHandles("r1") == ["R1"]

    def test_accepts_ints(self):
        assert coerceHandles([1, 2]) == ["1", "2"]

    def test_drops_empty_and_non_scalar(self):
        assert coerceHandles(["", "  ", {"x": 1}, None, "R1"]) == ["R1"]

    def test_non_list_non_string_returns_empty(self):
        assert coerceHandles(None) == []
        assert coerceHandles(42) == []


# --- clean_reply ------------------------------------------------------------
class TestCleanReply:
    def test_strips_leading_speaker_tag(self):
        assert cleanReply("[Mary, CFO] Hello there") == "Hello there"

    def test_leaves_untagged_text(self):
        assert cleanReply("Hello there") == "Hello there"

    def test_handles_none_and_whitespace(self):
        assert cleanReply(None) == ""
        assert cleanReply("   hi  ") == "hi"

    def test_only_strips_a_leading_bracket_not_mid_text(self):
        assert cleanReply("Costs are high [see attached]") == "Costs are high [see attached]"


# --- sanitize_history -------------------------------------------------------
class TestSanitizeHistory:
    def test_no_locked_names_returns_history_unchanged(self):
        history = [{"role": "assistant", "content": "talk to Bob"}]
        assert sanitizeHistory(history, []) is history

    def test_redacts_locked_name_in_assistant_messages(self):
        history = [{"role": "assistant", "content": "You should talk to Bob about this."}]
        out = sanitizeHistory(history, ["Bob"])
        assert out[0]["content"] == "You should talk to my contact about this."

    def test_does_not_touch_user_messages(self):
        history = [{"role": "user", "content": "Is Bob available?"}]
        out = sanitizeHistory(history, ["Bob"])
        assert out[0]["content"] == "Is Bob available?"

    def test_whole_word_only(self):
        # "Bobby" must not be partially redacted by the "Bob" rule.
        history = [{"role": "assistant", "content": "Bobby stayed"}]
        out = sanitizeHistory(history, ["Bob"])
        assert out[0]["content"] == "Bobby stayed"

    def test_empty_locked_name_does_not_corrupt_content(self):
        # An unnamed (empty-name) forbidden persona must be a no-op, not a
        # regex that matches every word boundary and rewrites the whole message.
        history = [{"role": "assistant", "content": "Costs are rising quickly"}]
        out = sanitizeHistory(history, [""])
        assert out[0]["content"] == "Costs are rising quickly"


# --- build_system_prompt ----------------------------------------------------
def persona(**over):
    base = {
        "name": "Mary",
        "role": "CFO",
        "known_facts": "The vendor is Acme. Contact Bob for details.",
        "personality_traits": "terse",
    }
    base.update(over)
    return base


def case():
    return {"initial_brief": "Reduce costs.", "common_information": "Company X"}


class TestBuildSystemPrompt:
    def test_stable_prompt_carries_persona_identity(self):
        stable, turn = systemPrompt(
            case(), persona(),
            forbidden_referral_names=[], eligible_referrals=[], eligible_files=[], withheld_file_names=[],
        )
        assert "Persona name: Mary" in stable
        assert "Role/title: CFO" in stable

    def test_eligible_referral_listed_with_handle(self):
        stable, turn = systemPrompt(
            case(), persona(),
            forbidden_referral_names=[],
            eligible_referrals=[{"handle": "R1", "name": "Sam", "role": "COO"}],
            eligible_files=[], withheld_file_names=[],
        )
        assert "R1: Sam (COO)" in turn

    def test_no_referrals_produces_negative_guidance(self):
        stable, turn = systemPrompt(
            case(), persona(),
            forbidden_referral_names=[], eligible_referrals=[], eligible_files=[], withheld_file_names=[],
        )
        assert "no one to introduce" in turn

    def test_forbidden_name_is_redacted_from_known_facts(self):
        stable, turn = systemPrompt(
            case(), persona(),
            forbidden_referral_names=["Bob"], eligible_referrals=[], eligible_files=[], withheld_file_names=[],
        )
        assert "Bob" not in stable
        assert "[undisclosed contact]" in stable

    def test_empty_forbidden_name_does_not_corrupt_known_facts(self):
        # A forbidden persona with an empty name must not rewrite the facts text.
        facts = "The vendor is Acme and costs are rising."
        stable, turn = systemPrompt(
            case(), persona(known_facts=facts),
            forbidden_referral_names=[""], eligible_referrals=[], eligible_files=[], withheld_file_names=[],
        )
        assert facts in stable

    def test_none_known_facts_renders_literal_none(self):
        stable, turn = systemPrompt(
            case(), persona(known_facts=None),
            forbidden_referral_names=[], eligible_referrals=[], eligible_files=[], withheld_file_names=[],
        )
        assert "Persona information: None" in stable
