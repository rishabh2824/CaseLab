# The five states of a small state machine. It walks the token stream looking for the key "reply", then its :, then
# the opening " of the value, then streams the value's characters out, then stops.
SEEK_KEY = "seek_key"      # The top-level `reply` key
SEEK_COLON = "seek_colon"  # matched `reply`, expecting `:`
SEEK_QUOTE = "seek_quote"  # expecting the opening `"` of the value
IN_VALUE = "in_value"      # inside the reply string; emit decoded chars
DONE = "done"              # value closed; nothing more to emit


# Maps single-char JSON escapes (\n, \t, \", etc.) to their literal characters.
SIMPLE_ESCAPES = {
    '"': '"', "\\": "\\", "/": "/",
    "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t",
}

REPLACEMENT = "�"  # Unicode replacement character, for malformed/unpaired escapes


class ReplyExtractor:
    def __init__(self) -> None:
        self.state = SEEK_KEY
        self.found_reply = False
        self.depth = 0
        self.containers: list[str] = []
        self.expect_key = False
        self.in_string = False
        self.escape = False
        self.key_active = False
        self.key_buf: list[str] = []
        self.pending = ""


    @property
    def done(self) -> bool:
        return self.state == DONE


    def feed(self, chunk: str) -> str:
        if not chunk or self.state == DONE:
            return ""
        out: list[str] = []
        i, n = 0, len(chunk)
        while i < n and self.state != DONE:
            if self.state == IN_VALUE:
                out.append(self.consumeValue(chunk[i:]))
                break  # consume_value handles the entire remainder (emit + holdback)
            c = chunk[i]
            if self.state == SEEK_KEY:
                self.seekKey(c)
                i += 1
            elif self.state == SEEK_COLON:
                if c.isspace():
                    i += 1
                elif c == ":":
                    self.state = SEEK_QUOTE
                    i += 1
                else:
                    self.state = SEEK_KEY  # defensive: reprocess this char structurally
            elif self.state == SEEK_QUOTE:
                if c.isspace():
                    i += 1
                elif c == '"':
                    self.state = IN_VALUE
                    self.found_reply = True
                    i += 1
                else:
                    self.state = SEEK_KEY
        return "".join(out)


    # Structural scan: track nesting/string state to recognize the top-level `reply` key without being fooled by
    # `"reply"` inside a value.
    def seekKey(self, c: str) -> None:
        if self.in_string:
            if self.escape:
                self.escape = False
                self.key_active = False  # an escape means the key can't be literally "reply"
                return
            if c == "\\":
                self.escape = True
                self.key_active = False
                return
            if c == '"':
                self.in_string = False
                if self.key_active:
                    if "".join(self.key_buf) == "reply":
                        self.state = SEEK_COLON
                    self.key_active = False
                return
            if self.key_active and len(self.key_buf) <= 5:
                self.key_buf.append(c)
            return

        if c == '"':
            self.in_string = True
            self.key_active = (
                self.depth == 1 and bool(self.containers)
                and self.containers[-1] == "o" and self.expect_key
            )
            self.key_buf = []
        elif c == "{":
            self.depth += 1
            self.containers.append("o")
            self.expect_key = True
        elif c == "[":
            self.depth += 1
            self.containers.append("a")
            self.expect_key = False
        elif c in "}]":
            self.depth -= 1
            if self.containers:
                self.containers.pop()
            self.expect_key = False  # corrected by the next comma if a key follows
        elif c == ":":
            self.expect_key = False
        elif c == ",":
            self.expect_key = bool(self.containers) and self.containers[-1] == "o"


    # Decode the reply string value from `text`
    def consumeValue(self, text: str) -> str:
        buf = self.pending + text
        self.pending = ""
        out: list[str] = []
        i, n = 0, len(buf)
        while i < n:
            c = buf[i]
            if c == '"':
                self.state = DONE
                return "".join(out)
            if c != "\\":
                out.append(c)
                i += 1
                continue
            # Escape sequence starting at i.
            if i + 1 >= n:
                self.pending = buf[i:]  # lone backslash — need next char
                break
            e = buf[i + 1]
            if e != "u":
                out.append(SIMPLE_ESCAPES.get(e, e))
                i += 2
                continue
            # \uXXXX
            if i + 6 > n:
                self.pending = buf[i:]  # partial \uXXXX
                break
            code = hex4(buf[i + 2:i + 6])
            if code is None:
                out.append(REPLACEMENT)
                i += 6
                continue
            if 0xD800 <= code <= 0xDBFF:  # high surrogate — needs a following low surrogate
                rest = buf[i + 6:]
                if len(rest) >= 6 and rest[0] == "\\" and rest[1] == "u":
                    lo = hex4(rest[2:6])
                    if lo is not None and 0xDC00 <= lo <= 0xDFFF:
                        out.append(chr(0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00)))
                        i += 12
                        continue
                    out.append(REPLACEMENT)  # `\u` follows but isn't a valid low surrogate
                    i += 6
                    continue
                if rest == "" or rest == "\\" or (len(rest) < 6 and rest[:2] == "\\u"):
                    self.pending = buf[i:]  # a low surrogate might still be arriving
                    break
                out.append(REPLACEMENT)  # definitively unpaired high surrogate
                i += 6
                continue
            if 0xDC00 <= code <= 0xDFFF:  # lone low surrogate
                out.append(REPLACEMENT)
                i += 6
                continue
            out.append(chr(code))
            i += 6
        return "".join(out)


def hex4(s: str) -> int | None:
    try:
        return int(s, 16)
    except ValueError:
        return None
