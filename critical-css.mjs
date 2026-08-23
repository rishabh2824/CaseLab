// Post-build step: Vite always emits page CSS as an external file linked via
// a blocking <link rel="stylesheet">, forcing a full round trip before the
// browser can paint anything — the render-blocking chain Lighthouse flagged
// (HTML -> CSS -> the @font-face files CSS references). The landing page's
// CSS is small (~50KB raw, ~10KB gzipped) and entirely used above the fold,
// so there's no real "critical vs. non-critical" split to do.
//
// Tried plain inlining first (replace the <link> with an equivalent
// <style>) and it backfired: SvelteKit's client runtime (kit.start()) reads
// the route's required CSS from its own manifest and unconditionally
// injects a fresh <link rel="stylesheet"> for it on hydration if it doesn't
// find one already in the DOM — since a <style> tag doesn't satisfy that
// check, the browser was downloading the same CSS a second time right after
// hydrating (confirmed via the preview server's network log). Keeping the
// original <link> at the same href but making it non-blocking (the classic
// preload + swap-on-load trick) fixes this: the browser paints from the
// inlined <style> immediately, the <link> loads the same URL in the
// background without blocking render, and because it's the same href kit
// finds later, its own hydration-time injection resolves from the browser's
// already-in-flight/cached fetch instead of firing a second network request.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "build");
// Every route is client-only now (see vite.config.ts's adapter comment), so
// index.html -- the SPA fallback -- is the only HTML file the build emits.
const targets = ["index.html"];

// A target existing but ending up unchanged means the <link rel="stylesheet"> regex above
// no longer matches Vite's output (e.g. its attribute order changed) — silently leaving
// `changed` false would ship that page with render-blocking CSS, unnoticed, since nothing
// else checks this build step's output. Fail the build instead.
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
			// The CSS's own relative url(...) references (the @font-face files) resolve
			// against the CSS file's location (e.g. /_app/immutable/assets/). Moving the
			// same text verbatim into a <style> tag in index.html re-resolves them against
			// "/" instead, 404ing every font -- rewrite to absolute paths first.
			const cssDir = href.slice(0, href.lastIndexOf("/") + 1);
			const css = readFileSync(cssPath, "utf-8").replace(
				/url\((['"]?)(\.\.?\/[^'")]+)\1\)/g,
				(_match, quote, rel) =>
					`url(${quote}${new URL(rel, `https://_${cssDir}`).pathname}${quote})`,
			);
			return (
				`<style>${css}</style>` +
				`<link rel="preload" href="${href}" as="style" onload="this.onload=null;this.rel='stylesheet'">` +
				`<noscript><link href="${href}" rel="stylesheet"></noscript>`
			);
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
