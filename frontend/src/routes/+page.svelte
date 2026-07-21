<script lang="ts">
	import { goto } from '$app/navigation'
	import { apiFetch } from '$lib/api/client.js'
	import { session } from '$lib/session.svelte.js'
	import SignInButton from '$lib/components/SignInButton.svelte'
	import type { RunState, StartSimulationPayload } from '$lib/types.js'

	let accessCode = $state('')
	let error = $state('')
	let isSubmitting = $state(false)

	async function submit(code: string): Promise<void> {
		isSubmitting = true
		try {
			const normalized = code.toUpperCase()
			const data = await apiFetch<RunState>('/api/simulations/start', {
				method: 'POST',
				body: { access_code: normalized } satisfies StartSimulationPayload,
			})
			error = ''
			session.startRun({
				runId: data.run_id,
				accessCode: normalized,
				startTime: Date.now(),
			})
			await goto('/student')
		} catch {
			error = 'Invalid access code.'
		} finally {
			isSubmitting = false
		}
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault()
		const code = accessCode.trim()
		if (!code) {
			error = 'Invalid access code.'
			return
		}
		submit(code)
	}
</script>

<svelte:head>
	<link rel="preload" as="image" href="/Bg.webp" />
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

	<div class="absolute bottom-6 right-6 z-10 sm:bottom-auto sm:top-12 sm:right-20">
		<SignInButton
			class="rounded-full border-2 border-brand bg-white/70 px-6 py-3 font-mono text-sm uppercase tracking-[0.2em] text-stone shadow-sm backdrop-blur transition hover:bg-brand hover:text-ink"
		>
			Admin Login
		</SignInButton>
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
