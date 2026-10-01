import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = join(
	dirname(fileURLToPath(import.meta.url)),
	process.env.BUILD_DIR ?? "build",
);
const targets = ["index.html"];

let failed = false;

for (const name of targets) {
	const htmlPath = join(buildDir, name);
	if (!existsSync(htmlPath)) continue;

	const html = readFileSync(htmlPath, "utf-8");
	let changed = false;

	const inlined = html.replace(
		/<link href="([^"]+\.css)" rel="stylesheet">/g,
		(match, href) => {
			const cssPath = join(buildDir, href.replace(/^\.\//, ""));
			if (!existsSync(cssPath)) return match;
			changed = true;
			const cssDir = href.slice(0, href.lastIndexOf("/") + 1);
			const css = readFileSync(cssPath, "utf-8").replace(
				/url\((['"]?)(\.\.?\/[^'")]+)\1\)/g,
				(_match, quote, rel) =>
					`url(${quote}${new URL(rel, `https://_${cssDir}`).pathname}${quote})`,
			);
			return `<style>${css}</style>`;
		},
	);

	if (changed) {
		writeFileSync(htmlPath, inlined);
		console.log(`inline-critical-css: inlined CSS into ${name}`);
	} else {
		console.error(
			`inline-critical-css: found no <link rel="stylesheet"> to inline in ${name} — ` +
				"the regex no longer matches Vite's output, or this page has no page CSS. " +
				"Either fix the regex or remove this target if it's now expected.",
		);
		failed = true;
	}
}

if (failed) process.exit(1);
