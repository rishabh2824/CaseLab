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

const REPLACEMENT = "�";

export class ReplyExtractor {
	done = false;
	#buf = "";
	#inValue = false;

	// Accepts the next chunk of streamed JSON and returns any newly decoded reply text.
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

	// Decodes the reply string's escapes, holding back an incomplete escape until the next chunk.
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
