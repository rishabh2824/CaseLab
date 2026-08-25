<script lang="ts">
import { getConvexClient } from "convex-svelte";
import { goto } from "$app/navigation";
import { session } from "$lib/session.svelte.js";
import type { StartedRun } from "$lib/student/run.svelte.js";
import { startSimulationRef } from "$lib/student/run.svelte.js";

let accessCode = $state("");
let error = $state("");
let isSubmitting = $state(false);

// startSimulation's own deliberate rejections (services/simulations.ts) -- shown verbatim,
// since they're written for a student to read. Anything else (a network failure, an
// unhandled server exception) is a bug, not a bad access code, and got its own generic
// message here after one such crash was previously mislabeled "Invalid access code.",
// which sent debugging in exactly the wrong direction.
const KNOWN_START_ERRORS = new Set([
	"Access code is required.",
	"Invalid access code.",
	"This case has no personas configured.",
	"Too many simulations have been started with this access code recently. Please wait a moment and try again.",
]);

async function submit(code: string): Promise<void> {
	isSubmitting = true;
	try {
		const fresh = (await getConvexClient().mutation(startSimulationRef, {
			accessCode: code,
		})) as StartedRun;
		session.startRun({
			runId: fresh.run_id,
			accessCode: code,
			startTime: Date.now(),
		});
		error = "";
		await goto("/student");
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		error = KNOWN_START_ERRORS.has(message)
			? message
			: "Something went wrong starting the simulation. Please try again.";
	} finally {
		isSubmitting = false;
	}
}

function handleSubmit(event: SubmitEvent): void {
	event.preventDefault();
	const code = accessCode.trim();
	if (!code) {
		error = "Invalid access code.";
		return;
	}
	submit(code.toLowerCase());
}
</script>

<svelte:head>
	<link rel="preload" as="image" href="/Bg.webp" />

	<meta
		name="description"
		content="Enter your access code to start an interactive business case simulation from the Wisconsin School of Business, University of Wisconsin–Madison."
	/>
	<link rel="canonical" href="https://wisconsincaselab.com/" />

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Wisconsin Case Lab" />
	<meta property="og:title" content="Wisconsin Case Lab | Wisconsin School of Business" />
	<meta
		property="og:description"
		content="Enter your access code to start an interactive business case simulation from the Wisconsin School of Business, University of Wisconsin–Madison."
	/>
	<meta property="og:url" content="https://wisconsincaselab.com/" />
	<meta property="og:image" content="https://wisconsincaselab.com/WSBLogo.webp" />
	<meta property="og:image:alt" content="Wisconsin School of Business" />

	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="Wisconsin Case Lab | Wisconsin School of Business" />
	<meta
		name="twitter:description"
		content="Enter your access code to start an interactive business case simulation from the Wisconsin School of Business, University of Wisconsin–Madison."
	/>
	<meta name="twitter:image" content="https://wisconsincaselab.com/WSBLogo.webp" />

	{@html `<script type="application/ld+json">${JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'WebSite',
		name: 'Wisconsin Case Lab',
		url: 'https://wisconsincaselab.com/',
		description:
			'Interactive business case simulation platform from the Wisconsin School of Business, University of Wisconsin–Madison.',
		publisher: {
			'@type': 'CollegeOrUniversity',
			name: 'Wisconsin School of Business',
			url: 'https://business.wisc.edu/',
			parentOrganization: {
				'@type': 'CollegeOrUniversity',
				name: 'University of Wisconsin–Madison',
				url: 'https://www.wisc.edu/',
			},
		},
	})}</script>`}
</svelte:head>

<div
	class="landing-bg relative flex h-screen w-full flex-col items-center justify-center overflow-hidden bg-cover bg-center px-6 font-body"
>
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>

	<img
		src="/Chevron.webp"
		alt=""
		aria-hidden="true"
		class="pointer-events-none absolute -bottom-28 -right-28 z-0 w-[34rem] max-w-none select-none opacity-[0.22]"
	/>
	<img
		src="/HalfCircle.webp"
		alt=""
		aria-hidden="true"
		class="pointer-events-none absolute top-1/2 -left-28 z-0 w-72 max-w-none -translate-y-1/2 rotate-90 select-none opacity-[0.22]"
	/>

	<img
		src="/WSBLogo.webp"
		alt="Wisconsin School of Business"
		class="absolute left-6 top-6 z-10 h-12 w-auto sm:h-20"
	/>

	<div class="absolute right-6 top-6 z-10 sm:right-20 sm:top-12">
		<a
			href="/admin"
			class="rounded-full border-2 border-brand bg-white/70 px-6 py-3 font-mono text-sm uppercase tracking-[0.2em] text-stone shadow-sm backdrop-blur transition hover:bg-brand hover:text-ink"
		>
			Admin Login
		</a>
	</div>

	<div class="relative z-10 w-full max-w-lg text-center">
		<div class="mt-8 flex items-center justify-center gap-3">
			<span class="h-px w-8 bg-line"></span>
			<span class="font-mono text-[11px] uppercase tracking-[0.28em] text-brand">
				Wisconsin School of Business
			</span>
			<span class="h-px w-8 bg-line"></span>
		</div>

		<h1 class="mt-4 font-display text-4xl font-bold leading-[1.02] tracking-tight text-ink sm:text-5xl">
			Wisconsin Case Lab
		</h1>
		<p class="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-stone">
			Enter your access code to start the simulation.
		</p>

		<div
			class="mx-auto mt-9 max-w-sm overflow-hidden rounded-2xl border border-line bg-white text-left shadow-premium"
		>
			<div class="flex items-center justify-between border-b border-line-soft bg-cream px-5 py-2.5">
				<span class="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-brand">
					Case Studies
				</span>
			</div>

			<form onsubmit={handleSubmit} class="space-y-3 px-5 py-5">
				<input
					type="text"
					aria-label="Access code"
					placeholder="Enter access code"
					class="w-full rounded-xl border border-line bg-white px-4 py-3.5 text-center text-base tracking-[0.08em] text-ink shadow-sm transition placeholder:tracking-normal placeholder:text-stone-soft focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
					bind:value={accessCode}
				/>
				{#if error}
					<p class="text-center text-sm font-medium text-brand">{error}</p>
				{/if}
				<button
					type="submit"
					disabled={isSubmitting}
					class="w-full rounded-xl bg-brand px-5 py-3.5 text-base font-semibold text-white shadow-sm transition hover:brightness-95 focus:outline-none focus:ring-4 focus:ring-brand/25 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{isSubmitting ? 'Starting…' : 'Open Case'}
				</button>
			</form>
		</div>
	</div>
</div>
