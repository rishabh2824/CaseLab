"""Incrementally pull the ``reply`` string out of a persona's structured-output
JSON *as it streams*, so the SSE layer can forward reply text token-by-token
instead of waiting for the whole envelope.

The persona reply is a constrained JSON object like
``{"reply": "...", "introduce": [...], "send_files": [...]}`` (see
PERSONA_REPLY_SCHEMA). ``ReplyExtractor`` is a tiny JSON lexer that finds the
top-level ``reply`` key, then decodes and emits its string value character by
character, tolerant of any chunk-split point (escapes and surrogate pairs may
be cut across ``feed()`` calls) and of ``reply`` appearing anywhere in the
object — or nowhere.

Degradation guarantee: if ``reply`` never surfaces, ``feed()`` returns ``""``
and ``found_reply`` stays False, so the caller can fall back to a single delta
built from the authoritative full-text parse. A bug in this lexer can only
*fail to stream early* — it can never lose or corrupt the final reply, which is
always re-parsed from the concatenated raw text downstream.
"""

# Lexer states
_SEEK_KEY = "seek_key"      # scanning JSON structure for the top-level `reply` key
_SEEK_COLON = "seek_colon"  # matched `reply`, expecting `:`
_SEEK_QUOTE = "seek_quote"  # expecting the opening `"` of the value
_IN_VALUE = "in_value"      # inside the reply string; emit decoded chars
_DONE = "done"              # value closed; nothing more to emit

_SIMPLE_ESCAPES = {
    '"': '"', "\\": "\\", "/": "/",
    "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t",
}
_REPLACEMENT = "�"  # Unicode replacement character, for malformed/unpaired escapes


class ReplyExtractor:
    def __init__(self) -> None:
        self.state = _SEEK_KEY
        self.found_reply = False
        # --- structural scan state (used only in _SEEK_KEY) ---
        self._depth = 0
        self._containers: list[str] = []  # 'o' (object) / 'a' (array)
        self._expect_key = False
        self._in_string = False
        self._escape = False
        self._key_active = False          # current string is a depth-1 object key candidate
        self._key_buf: list[str] = []
        # --- value-decode state (used only in _IN_VALUE) ---
        self._pending = ""                # incomplete escape/surrogate held across chunks

    @property
    def done(self) -> bool:
        return self.state == _DONE

    def feed(self, chunk: str) -> str:
        if not chunk or self.state == _DONE:
            return ""
        out: list[str] = []
        i, n = 0, len(chunk)
        while i < n and self.state != _DONE:
            if self.state == _IN_VALUE:
                out.append(self._consume_value(chunk[i:]))
                break  # _consume_value handles the entire remainder (emit + holdback)
            c = chunk[i]
            if self.state == _SEEK_KEY:
                self._seek_key(c)
                i += 1
            elif self.state == _SEEK_COLON:
                if c.isspace():
                    i += 1
                elif c == ":":
                    self.state = _SEEK_QUOTE
                    i += 1
                else:
                    self.state = _SEEK_KEY  # defensive: reprocess this char structurally
            elif self.state == _SEEK_QUOTE:
                if c.isspace():
                    i += 1
                elif c == '"':
                    self.state = _IN_VALUE
                    self.found_reply = True
                    i += 1
                else:
                    self.state = _SEEK_KEY  # defensive: reprocess this char structurally
        return "".join(out)

    # Structural scan: track nesting/string state well enough to recognize the
    # top-level `reply` key without being fooled by `"reply"` inside a value.
    def _seek_key(self, c: str) -> None:
        if self._in_string:
            if self._escape:
                self._escape = False
                self._key_active = False  # an escape means the key can't be literally "reply"
                return
            if c == "\\":
                self._escape = True
                self._key_active = False
                return
            if c == '"':
                self._in_string = False
                if self._key_active:
                    if "".join(self._key_buf) == "reply":
                        self.state = _SEEK_COLON
                    self._key_active = False
                return
            if self._key_active and len(self._key_buf) <= 5:
                self._key_buf.append(c)
            return

        if c == '"':
            self._in_string = True
            self._key_active = (
                self._depth == 1 and bool(self._containers)
                and self._containers[-1] == "o" and self._expect_key
            )
            self._key_buf = []
        elif c == "{":
            self._depth += 1
            self._containers.append("o")
            self._expect_key = True
        elif c == "[":
            self._depth += 1
            self._containers.append("a")
            self._expect_key = False
        elif c in "}]":
            self._depth -= 1
            if self._containers:
                self._containers.pop()
            self._expect_key = False  # corrected by the next comma if a key follows
        elif c == ":":
            self._expect_key = False
        elif c == ",":
            self._expect_key = bool(self._containers) and self._containers[-1] == "o"
        # whitespace and value literals (numbers/true/false/null) need no tracking

    # Decode the reply string value from `text` (prefixed by any held partial
    # escape). Emits fully-decoded characters, holds an incomplete escape tail in
    # self._pending, and transitions to _DONE on the closing quote.
    def _consume_value(self, text: str) -> str:
        buf = self._pending + text
        self._pending = ""
        out: list[str] = []
        i, n = 0, len(buf)
        while i < n:
            c = buf[i]
            if c == '"':
                self.state = _DONE
                return "".join(out)
            if c != "\\":
                out.append(c)
                i += 1
                continue
            # Escape sequence starting at i.
            if i + 1 >= n:
                self._pending = buf[i:]  # lone backslash — need next char
                break
            e = buf[i + 1]
            if e != "u":
                out.append(_SIMPLE_ESCAPES.get(e, e))
                i += 2
                continue
            # \uXXXX
            if i + 6 > n:
                self._pending = buf[i:]  # partial \uXXXX
                break
            code = _hex4(buf[i + 2:i + 6])
            if code is None:
                out.append(_REPLACEMENT)
                i += 6
                continue
            if 0xD800 <= code <= 0xDBFF:  # high surrogate — needs a following low surrogate
                rest = buf[i + 6:]
                if len(rest) >= 6 and rest[0] == "\\" and rest[1] == "u":
                    lo = _hex4(rest[2:6])
                    if lo is not None and 0xDC00 <= lo <= 0xDFFF:
                        out.append(chr(0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00)))
                        i += 12
                        continue
                    out.append(_REPLACEMENT)  # `\u` follows but isn't a valid low surrogate
                    i += 6
                    continue
                if rest == "" or rest == "\\" or (len(rest) < 6 and rest[:2] == "\\u"):
                    self._pending = buf[i:]  # a low surrogate might still be arriving
                    break
                out.append(_REPLACEMENT)  # definitively unpaired high surrogate
                i += 6
                continue
            if 0xDC00 <= code <= 0xDFFF:  # lone low surrogate
                out.append(_REPLACEMENT)
                i += 6
                continue
            out.append(chr(code))
            i += 6
        return "".join(out)


def _hex4(s: str) -> int | None:
    try:
        return int(s, 16)
    except ValueError:
        return None
