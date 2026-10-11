import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".txt": "text/plain",
};

export const APP_PORT = 4173;

// Serves a built static site, falling back to index.html for client-side routes. Returns a function that stops it.
export function startStaticServer(root: string): Promise<() => Promise<void>> {
	const base = path.resolve(root);
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		let file = path.join(base, decodeURIComponent(url.pathname));
		if (
			!file.startsWith(base) ||
			!fs.existsSync(file) ||
			fs.statSync(file).isDirectory()
		) {
			file = path.join(base, "index.html");
		}
		res.setHeader(
			"content-type",
			TYPES[path.extname(file)] ?? "application/octet-stream",
		);
		fs.createReadStream(file).pipe(res);
	});
	return new Promise((resolve) => {
		server.listen(APP_PORT, "localhost", () => {
			resolve(() => new Promise<void>((done) => server.close(() => done())));
		});
	});
}
