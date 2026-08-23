// The provider streams with strict structured-output decoding (see lib/llm.ts's
// PERSONA_REPLY_SCHEMA), which guarantees the output is always valid JSON, "reply" is always
// the object's first key (property order in PERSONA_REPLY_SCHEMA), and non-ASCII characters
// (emoji, accents, etc.) are emitted as raw UTF-8 rather than \uXXXX surrogate-pair escapes.
// So there's no need to track JSON structure/nesting to avoid a false-positive "reply" match,
// and no need to reconstruct surrogate pairs -- just skip the fixed prefix up to reply's
// opening quote, then stream its characters out until the matching unescaped closing quote.
const PREFIX_RE = /^\s*\{\s*"reply"\s*:\s*"/;

const SIMPLE_ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

const REPLACEMENT = "�"; // Unicode replacement character, for a malformed \u escape

export class ReplyExtractor {
	// stream.py's ReplyExtractor also exposed a `found_reply` flag (whether the "reply" field
	// had been reached yet), for the old SSE frame protocol to tell "the model never got to
	// the reply field" apart from "the reply field was empty". Not ported: nothing here reads
	// it either way, since the terminal reply is always re-derived from the full accumulated
	// text (services/turn.ts's `parseReply(fullText)`) once streaming ends, independent of
	// whatever this extractor did incrementally -- `done` (below) is the only state this
	// class's own logic actually depends on.
	done = false;
	#buf = "";
	#inValue = false;

	feed(chunk: string): string {
		if (this.done || !chunk) return "";
		if (!this.#inValue) {
			this.#buf += chunk;
			const match = PREFIX_RE.exec(this.#buf);
			if (!match) return "";
			this.#inValue = true;
			chunk = this.#buf.slice(match[0].length);
			this.#buf = "";
		}
		return this.#consumeValue(chunk);
	}

	// Decodes reply-string characters out of `text`, up to (not including) the closing
	// quote. `#buf` carries over a trailing partial escape (a lone "\" or a `\u` sequence
	// cut off mid-token) for the next feed() to complete.
	#consumeValue(text: string): string {
		const buf = this.#buf + text;
		this.#buf = "";
		const out: string[] = [];
		let i = 0;
		const n = buf.length;
		while (i < n) {
			const c = buf[i]!;
			if (c === '"') {
				this.done = true;
				return out.join("");
			}
			if (c !== "\\") {
				out.push(c);
				i += 1;
				continue;
			}
			if (i + 1 >= n) {
				this.#buf = buf.slice(i);
				break;
			}
			const escaped = buf[i + 1]!;
			if (escaped !== "u") {
				out.push(SIMPLE_ESCAPES[escaped] ?? escaped);
				i += 2;
				continue;
			}
			if (i + 6 > n) {
				this.#buf = buf.slice(i);
				break;
			}
			const code = Number.parseInt(buf.slice(i + 2, i + 6), 16);
			out.push(Number.isNaN(code) ? REPLACEMENT : String.fromCharCode(code));
			i += 6;
		}
		return out.join("");
	}
}
