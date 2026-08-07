"""services/simulation/reply_stream.py — ReplyExtractor, the incremental "reply"-field
extractor that powers the live streaming preview. Relies on the provider's strict
structured-output decoding guaranteeing valid JSON with "reply" as the first key (see
the module docstring in reply_stream.py) — these tests exercise that contract, not
arbitrary/malformed JSON.
"""

from __future__ import annotations

from services.simulation.reply_stream import ReplyExtractor


def feedAll(extractor: ReplyExtractor, chunks: list[str]) -> str:
    return "".join(extractor.feed(chunk) for chunk in chunks)


def test_extracts_reply_text_fed_in_one_chunk():
    extractor = ReplyExtractor()
    envelope = '{"reply": "Hello there.", "introduce": [], "send_files": []}'
    assert extractor.feed(envelope) == "Hello there."
    assert extractor.found_reply is True
    assert extractor.done is True


def test_extracts_reply_text_split_across_arbitrary_chunk_boundaries():
    extractor = ReplyExtractor()
    envelope = '{"reply": "Hello there.", "introduce": [], "send_files": []}'
    # One character per feed() call — the most adversarial chunking possible, including
    # splitting mid-prefix and mid-value.
    chunks = list(envelope)
    assert feedAll(extractor, chunks) == "Hello there."
    assert extractor.found_reply is True


def test_stops_emitting_once_the_value_closes():
    extractor = ReplyExtractor()
    chunks = [
        '{"reply": "Hi.', '", "introduce": ["R1"]', ', "send_files": []}',
    ]
    assert feedAll(extractor, chunks) == "Hi."
    # The trailing JSON (introduce/send_files) must never leak into the live preview.
    assert extractor.feed("more text") == ""


def test_decodes_simple_escapes():
    extractor = ReplyExtractor()
    envelope = r'{"reply": "Line one\nLine \"two\" with a \\ backslash.", "introduce": [], "send_files": []}'
    assert extractor.feed(envelope) == 'Line one\nLine "two" with a \\ backslash.'


def test_decodes_unicode_escape_split_mid_sequence():
    extractor = ReplyExtractor()
    # é == "é". Split right in the middle of the escape sequence.
    chunks = ['{"reply": "caf', '\\u00', "e9", '", "introduce": [], "send_files": []}']
    assert feedAll(extractor, chunks) == "café"


def test_decodes_raw_utf8_astral_characters_without_escaping():
    extractor = ReplyExtractor()
    # Strict structured-output decoders emit astral characters (emoji) as raw UTF-8,
    # never as \uXXXX surrogate-pair escapes — this is the case the module docstring
    # says makes surrogate-pair reconstruction unnecessary.
    envelope = '{"reply": "Great news 🎉", "introduce": [], "send_files": []}'
    assert extractor.feed(envelope) == "Great news 🎉"


def test_lone_backslash_at_chunk_boundary_is_carried_over():
    extractor = ReplyExtractor()
    chunks = ['{"reply": "a', "\\", 'n', 'b", "introduce": [], "send_files": []}']
    assert feedAll(extractor, chunks) == "a\nb"


def test_found_reply_stays_false_when_prefix_never_matches():
    extractor = ReplyExtractor()
    # No "reply" key at all — malformed relative to the schema contract.
    assert extractor.feed('{"introduce": [], "send_files": []}') == ""
    assert extractor.found_reply is False
    assert extractor.done is False


def test_empty_chunk_and_post_done_feed_are_no_ops():
    extractor = ReplyExtractor()
    assert extractor.feed("") == ""
    extractor.feed('{"reply": "Hi."')
    extractor.feed('"}')
    assert extractor.done is True
    assert extractor.feed("ignored") == ""
