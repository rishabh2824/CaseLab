
import pytest

from services.simulation.reply_stream import ReplyExtractor

BS = "\\"  # one backslash
REPL = "�"  # Unicode replacement character
EMOJI = "\U0001F600"  # 😀, encoded in JSON as the surrogate pair 😀


def u(hexcode: str) -> str:
    return BS + "u" + hexcode


def whole(s):
    return [s]


def chars(s):
    return list(s)


def by(n):
    return lambda s: [s[i:i + n] for i in range(0, len(s), n)] or [""]


CHUNKERS = [whole, chars, by(2), by(3), by(7)]
CHUNKER_IDS = ["whole", "chars", "by2", "by3", "by7"]

# (id, raw JSON text, expected reply, expected found_reply)
CASES = [
    ("happy", '{"reply": "Hello world", "introduce": [], "send_files": []}', "Hello world", True),
    ("reply_last", '{"introduce": [], "send_files": [], "reply": "Bye"}', "Bye", True),
    ("empty_reply", '{"reply": "", "introduce": []}', "", True),
    (
        "simple_escapes",
        '{"reply": "a' + BS + "nb" + BS + "t" + BS + '"c' + BS + '"' + BS + BS + "d" + BS + '/e"}',
        "a\nb\t\"c\"\\d/e",
        True,
    ),
    ("backspace_formfeed", '{"reply": "x' + BS + "by" + BS + 'fz"}', "x\by\fz", True),
    ("unicode_escape", '{"reply": "caf' + u("00e9") + '"}', "café", True),
    ("surrogate_pair", '{"reply": "hi ' + u("d83d") + u("de00") + '!"}', "hi " + EMOJI + "!", True),
    ("unpaired_high_surrogate", '{"reply": "' + u("d83d") + 'X"}', REPL + "X", True),
    ("lone_low_surrogate", '{"reply": "' + u("de00") + 'Y"}', REPL + "Y", True),
    ("braces_in_value", '{"reply": "use {this} or [that]", "introduce": []}', "use {this} or [that]", True),
    ("whitespace_around_colon", '{"reply"\n\t:  \n  "spaced"}', "spaced", True),
    (
        "poison_reply_in_value",
        '{"note": "the key ' + BS + '"reply' + BS + '": is tricky", "reply": "real"}',
        "real",
        True,
    ),
    ("nested_reply_key", '{"meta": {"reply": "nested"}, "reply": "top"}', "top", True),
    ("content_after_value", '{"reply": "done", "introduce": ["R1"]}', "done", True),
    ("reply_absent", '{"introduce": [], "send_files": []}', "", False),
    ("not_json", "not json at all", "", False),
    ("empty_input", "", "", False),
]


@pytest.mark.parametrize("chunker", CHUNKERS, ids=CHUNKER_IDS)
@pytest.mark.parametrize("case", CASES, ids=[c[0] for c in CASES])
def test_extract(case, chunker):
    id, text, expected, found = case
    ex = ReplyExtractor()
    out = "".join(ex.feed(chunk) for chunk in chunker(text))
    assert out == expected
    assert ex.found_reply is found


@pytest.mark.parametrize("chunker", CHUNKERS, ids=CHUNKER_IDS)
def test_done_flag_set_after_value_closes(chunker):
    ex = ReplyExtractor()
    text = '{"reply": "hi", "introduce": []}'
    "".join(ex.feed(chunk) for chunk in chunker(text))
    assert ex.done is True


def test_feed_returns_empty_forever_after_done():
    ex = ReplyExtractor()
    ex.feed('{"reply": "hi"}')
    assert ex.done is True
    assert ex.feed('{"reply": "again"}') == ""


def test_unicode_escape_split_at_every_offset():
    # Split the é escape between every pair of characters to exercise the
    # partial-escape holdback at each boundary.
    prefix = '{"reply": "x'
    esc = u("00e9")
    full = prefix + esc + '"}'
    for cut in range(len(prefix), len(prefix) + len(esc)):
        ex = ReplyExtractor()
        out = ex.feed(full[:cut]) + ex.feed(full[cut:])
        assert out == "xé", f"cut at {cut}"


def test_surrogate_pair_split_between_the_two_escapes():
    prefix = '{"reply": "'
    full = prefix + u("d83d") + u("de00") + '"}'
    cut = len(prefix) + len(u("d83d"))  # split exactly between high and low surrogate
    ex = ReplyExtractor()
    out = ex.feed(full[:cut]) + ex.feed(full[cut:])
    assert out == EMOJI


def test_malformed_never_raises():
    for junk in ['{"reply": ', '{"reply": "' + BS + "ud8", "{{{{", '"reply"', '{"reply":"' + BS + 'q"}']:
        ex = ReplyExtractor()
        ex.feed(junk)  # must not raise regardless of how truncated/mangled the input is
