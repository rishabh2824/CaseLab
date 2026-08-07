import re

# The provider streams with strict structured-output decoding (PERSONA_REPLY_SCHEMA /
# response_format in infra/llm.py's personaReplyStream), which guarantees three things
# this extractor leans on: the output is always valid JSON, "reply" is always the
# object's first key (property order in PERSONA_REPLY_SCHEMA), and non-ASCII characters
# (emoji, accents, etc.) are emitted as raw UTF-8 rather than \uXXXX surrogate-pair
# escapes. So there's no need to track JSON structure/nesting to avoid a false-positive
# "reply" match, and no need to reconstruct surrogate pairs -- just skip the fixed prefix
# up to reply's opening quote, then stream its characters out until the matching
# unescaped closing quote.
PREFIX_RE = re.compile(r'^\s*\{\s*"reply"\s*:\s*"')

SIMPLE_ESCAPES = {
    '"': '"', "\\": "\\", "/": "/",
    "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t",
}

REPLACEMENT = "�"  # Unicode replacement character, for a malformed \u escape


class ReplyExtractor:
    def __init__(self) -> None:
        self.buf = ""
        self.in_value = False
        self.found_reply = False
        self.done = False

    def feed(self, chunk: str) -> str:
        if self.done or not chunk:
            return ""
        if not self.in_value:
            self.buf += chunk
            match = PREFIX_RE.match(self.buf)
            if not match:
                return ""
            self.in_value = True
            self.found_reply = True
            chunk = self.buf[match.end():]
            self.buf = ""
        return self.consumeValue(chunk)

    # Decodes reply-string characters out of `text`, up to (not including) the closing
    # quote. `self.buf` carries over a trailing partial escape (a lone "\" or a `\u`
    # sequence cut off mid-token) for the next feed() to complete.
    def consumeValue(self, text: str) -> str:
        buf = self.buf + text
        self.buf = ""
        out: list[str] = []
        i, n = 0, len(buf)
        while i < n:
            c = buf[i]
            if c == '"':
                self.done = True
                return "".join(out)
            if c != "\\":
                out.append(c)
                i += 1
                continue
            if i + 1 >= n:
                self.buf = buf[i:]
                break
            escape = buf[i + 1]
            if escape != "u":
                out.append(SIMPLE_ESCAPES.get(escape, escape))
                i += 2
                continue
            if i + 6 > n:
                self.buf = buf[i:]
                break
            try:
                out.append(chr(int(buf[i + 2 : i + 6], 16)))
            except ValueError:
                out.append(REPLACEMENT)
            i += 6
        return "".join(out)
