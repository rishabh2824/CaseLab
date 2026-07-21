<script lang="ts">
	import { untrack } from 'svelte'
	import { apiFetch } from '$lib/api/client.js'
	import {
		collectReferredPersonas,
		createEmptyPersona,
		getPersonaFieldErrors,
		getPersonaLabel,
		hasFieldErrors,
		normalizePersona,
	} from '$lib/case/Helpers.js'
	import { submitCase } from '$lib/case/submitCase.js'
	import { buildHTMLForm, downloadForm } from '$lib/case/exportCase.js'
	import { CaseImportError, parseHTMLForm } from '$lib/case/importCase.js'
	import PersonaFields from './PersonaFields.svelte'
	import type { CaseDetailResponse, DraftPersona, DraftReferral } from '$lib/types.js'

	const MAX_SIMULATION_DURATION = 120

	// Sourced straight from page.url.searchParams.get(...) by the routes that
	// render this form — real URL query strings, never parsed to a number.
	// Both are only ever interpolated into `/api/cases/${sourceCaseId}`.
	type Props = {
		templateId?: string | null
		editCaseId?: string | null
	}

	let { templateId = null, editCaseId = null }: Props = $props()

	const isEditMode = $derived(Boolean(editCaseId))
	const sourceCaseId = $derived(editCaseId || templateId)
	// Import is only offered on the blank "from scratch" new-case route
	const canImport = $derived(!sourceCaseId)

	let caseName = $state('')
	let initialBrief = $state('')
	let commonInformation = $state('')
	let simulationDurationMinutes = $state<number | null>(null)
	let accessCode = $state('')
	let totalPersonas = $state<number | null>(null)
	let personas = $state<DraftPersona[]>([])

	let showFieldErrors = $state(false)
	function revealErrors() {
		showFieldErrors = true
	}

	let isLoadingSource = $state(untrack(() => Boolean(sourceCaseId)))
	let loadErrorMessage = $state('')
	let submitError = $state('')
	let submitSuccess = $state('')
	let isSubmitting = $state(false)
	let importWarnings = $state<string[]>([])
	let importError = $state('')
	let fileInputEl = $state<HTMLInputElement | null>(null)

	$effect(() => {
		if (!sourceCaseId) return
		apiFetch<CaseDetailResponse>(`/api/cases/${sourceCaseId}`)
			.then((data) => {
				const templateCase = data.case
				caseName = templateCase.case_name ?? ''
				initialBrief = templateCase.initial_brief ?? ''
				commonInformation = templateCase.common_information ?? ''
				simulationDurationMinutes = templateCase.simulation_duration ?? null
				accessCode = templateCase.access_code ?? ''
				totalPersonas = templateCase.total_non_referred_personas ?? null
				personas = (templateCase.personas ?? []).map((persona) => normalizePersona(persona))
				revealErrors()
			})
			.catch((err: unknown) => {
				loadErrorMessage =
					(err instanceof Error && err.message) ||
					(isEditMode ? 'Failed to load case for editing.' : 'Failed to load case template.')
			})
			.finally(() => {
				isLoadingSource = false
			})
	})

	function parseIntOrNull(raw: string): number | null {
		if (raw === '') return null
		const parsed = Number(raw)
		return Number.isFinite(parsed) ? Math.trunc(parsed) : null
	}

	const showPersonas = $derived(typeof totalPersonas === 'number' && totalPersonas >= 1)

	const caseNameError = $derived(!caseName.trim() ? 'Case name is required.' : null)
	const initialBriefError = $derived(!initialBrief.trim() ? 'Initial brief is required.' : null)
	const accessCodeError = $derived(!accessCode.trim() ? 'Access code is required.' : null)
	const totalPersonasError = $derived(
		typeof totalPersonas !== 'number' || totalPersonas < 1 ? 'At least 1 persona is required' : null,
	)
	const simulationDurationError = $derived(
		typeof simulationDurationMinutes === 'number' &&
			(simulationDurationMinutes > MAX_SIMULATION_DURATION || simulationDurationMinutes < 1)
			? `Simulation duration must be between 1 and ${MAX_SIMULATION_DURATION} minutes (2 hours).`
			: null,
	)

	const referredPersonas = $derived(collectReferredPersonas(personas))
	const rootPersonaErrors = $derived(
		// showPersonas doesn't narrow totalPersonas here (separate $derived) —
		// re-check inline, same as the template's equivalent Array.from below.
		Array.from({ length: showPersonas && typeof totalPersonas === 'number' ? totalPersonas : 0 }, (_, index) =>
			getPersonaFieldErrors(normalizePersona(personas[index])),
		),
	)
	const referredPersonaErrors = $derived(referredPersonas.map((item) => getPersonaFieldErrors(item.persona)))
	const hasAnyPersonaError = $derived(
		rootPersonaErrors.some(hasFieldErrors) || referredPersonaErrors.some(hasFieldErrors),
	)
	const hasValidationErrors = $derived(
		Boolean(caseNameError) ||
			Boolean(initialBriefError) ||
			Boolean(accessCodeError) ||
			Boolean(totalPersonasError) ||
			Boolean(simulationDurationError) ||
			hasAnyPersonaError,
	)
	const displayedError = $derived(submitError || loadErrorMessage)

	// collectReferredPersonas (a pure helper, shared with export/import and validation) returns
	// normalized *copies* for labeling — walk the path back into the live $state tree so
	// PersonaFields binds to the real referred persona, not a throwaway snapshot.
	function resolveReferredPersona(path: number[]): DraftPersona {
		const rootIndex = path[0]
		if (rootIndex === undefined) throw new Error('Internal error: empty referral path.')
		let persona = personas[rootIndex]
		if (!persona) throw new Error('Internal error: root persona not found while resolving a referral path.')
		for (let depth = 1; depth < path.length; depth++) {
			const childIndex = path[depth]
			if (childIndex === undefined) throw new Error('Internal error: malformed referral path.')
			const referral: DraftReferral | undefined = persona.referrals[childIndex]
			if (!referral) throw new Error('Internal error: referred persona not found while resolving a referral path.')
			persona = referral.persona
		}
		return persona
	}

	function handleTotalPersonasChange(event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
		revealErrors()
		const value = parseIntOrNull(event.currentTarget.value)
		totalPersonas = value
		if (typeof value === 'number' && value >= 1) {
			if (personas.length > value) personas = personas.slice(0, value)
			while (personas.length < value) personas.push(createEmptyPersona())
		} else {
			personas = []
		}
	}

	// Builds a .html form from whatever's currently in this form
	function handleExportTemplate(): void {
		const html = buildHTMLForm({
			caseName,
			accessCode,
			simulationDurationMinutes,
			initialBrief,
			commonInformation,
			personas,
		})
		downloadForm(html, caseName)
	}

	function handleImportClick(): void {
		fileInputEl?.click()
	}

	// Parses a filled-in export back into form state
	async function handleImportFile(event: Event & { currentTarget: EventTarget & HTMLInputElement }): Promise<void> {
		const file = event.currentTarget.files?.[0]
		event.currentTarget.value = ''
		if (!file) return

		const hasExistingData = caseName.trim() || initialBrief.trim() || accessCode.trim() || personas.length > 0
		if (hasExistingData && !window.confirm('Import will replace everything currently in this form. Continue?')) {
			return
		}

		importError = ''
		importWarnings = []
		try {
			const text = await file.text()
			const { data, warnings } = parseHTMLForm(text)
			caseName = data.caseName
			accessCode = data.accessCode
			initialBrief = data.initialBrief
			commonInformation = data.commonInformation
			simulationDurationMinutes = data.simulationDurationMinutes
			totalPersonas = data.totalPersonas
			personas = data.personas
			importWarnings = warnings
			revealErrors()
		} catch (err) {
			importError =
				err instanceof CaseImportError
					? err.message
					: 'Failed to read that file. Make sure it’s an unmodified export from this app.'
		}
	}

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault()
		loadErrorMessage = ''
		submitError = ''
		submitSuccess = ''
		isSubmitting = true
		try {
			await submitCase({
				isEditMode,
				editCaseId,
				caseName,
				initialBrief,
				commonInformation,
				simulationDurationMinutes,
				accessCode,
				// The submit button is disabled while hasValidationErrors is true
				// (which requires totalPersonas to be a valid number), so this is
				// always a number by the time handleSubmit can actually run.
				totalPersonas: totalPersonas as number,
				personas,
			})
			submitSuccess = isEditMode ? 'Case updated successfully.' : 'Case saved successfully.'
		} catch (err) {
			submitError = (err instanceof Error && err.message) || 'Upload failed.'
		} finally {
			isSubmitting = false
		}
	}
</script>

<div class="relative min-h-screen bg-parchment">
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
	<div class="mx-auto max-w-4xl px-6 py-10">
		<div class="rounded-2xl border border-line bg-white p-8 shadow-soft">
			<form onsubmit={handleSubmit} class="flex flex-col gap-6">
				<div class="relative">
					<div class="text-center">
						<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
							Case Builder
						</p>
						<h1 class="mt-1.5 font-display text-3xl font-semibold text-ink">
							{isEditMode ? 'Edit Case Study' : 'New Case Study'}
						</h1>
					</div>
					<div class="absolute right-0 top-0 flex gap-2">
						{#if canImport}
							<input
								bind:this={fileInputEl}
								type="file"
								accept=".html,.htm,text/html"
								class="hidden"
								onchange={handleImportFile}
							/>
							<button
								type="button"
								onclick={handleImportClick}
								class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
							>
								Import template
							</button>
						{/if}
						<button
							type="button"
							onclick={handleExportTemplate}
							class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
						>
							Export template
						</button>
					</div>
				</div>

				{#if isLoadingSource}
					<p class="text-center text-sm text-stone">
						{isEditMode ? 'Loading case...' : 'Loading case template...'}
					</p>
				{/if}

				{#if importError}
					<div class="rounded-xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
						<div class="flex items-start justify-between gap-3">
							<p>{importError}</p>
							<button
								type="button"
								onclick={() => (importError = '')}
								class="text-xs font-semibold text-brand"
								aria-label="Dismiss"
							>
								&times;
							</button>
						</div>
					</div>
				{/if}

				{#if importWarnings.length > 0}
					<div class="rounded-xl border border-line bg-cream/60 px-4 py-3 text-sm text-ink-soft">
						<div class="flex items-start justify-between gap-3">
							<p class="font-semibold text-ink">
								Imported with {importWarnings.length} issue{importWarnings.length === 1 ? '' : 's'} to review
							</p>
							<button
								type="button"
								onclick={() => (importWarnings = [])}
								class="text-xs font-semibold text-stone-soft"
								aria-label="Dismiss"
							>
								&times;
							</button>
						</div>
						<ul class="mt-2 flex flex-col gap-1">
							{#each importWarnings as warning (warning)}
								<li class="text-xs">{warning}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<details class="rounded-2xl border border-line bg-white" open>
					<summary class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink">
						Case Information
					</summary>
					<div class="flex flex-col gap-4 border-t border-line-soft px-5 py-5">
						<div class="flex flex-col gap-1.5">
							<label for="case-name" class="text-xs font-medium text-stone-soft">Case name</label>
							<input
								id="case-name"
								type="text"
								required
								placeholder="Enter case name"
								bind:value={caseName}
								oninput={revealErrors}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
							{#if showFieldErrors && caseNameError}
								<p class="text-xs font-medium text-brand">{caseNameError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="initial-brief" class="text-xs font-medium text-stone-soft">Initial brief</label>
							<textarea
								id="initial-brief"
								rows="3"
								required
								placeholder="Summarize the initial brief"
								bind:value={initialBrief}
								oninput={revealErrors}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
							{#if showFieldErrors && initialBriefError}
								<p class="text-xs font-medium text-brand">{initialBriefError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="common-information" class="text-xs font-medium text-stone-soft">Enter Case Background</label>
							<textarea
								id="common-information"
								rows="3"
								placeholder="Describe the common information"
								bind:value={commonInformation}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="simulation-duration" class="text-xs font-medium text-stone-soft">Simulation duration (Minutes)</label>
							<input
								id="simulation-duration"
								type="number"
								min="1"
								max={MAX_SIMULATION_DURATION}
								step="1"
								placeholder="Leave empty for unlimited"
								value={simulationDurationMinutes ?? ''}
								oninput={(event) => {
									revealErrors()
									simulationDurationMinutes = parseIntOrNull(event.currentTarget.value)
								}}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
							{#if simulationDurationError}
								<p class="text-xs font-medium text-brand">{simulationDurationError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="access-code" class="text-xs font-medium text-stone-soft">Access code</label>
							<input
								id="access-code"
								type="text"
								required
								placeholder="Enter access code"
								bind:value={accessCode}
								oninput={revealErrors}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
							{#if showFieldErrors && accessCodeError}
								<p class="text-xs font-medium text-brand">{accessCodeError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="total-personas" class="text-xs font-medium text-stone-soft">
								Enter the Number of AI personas that are not referred
							</label>
							<input
								id="total-personas"
								type="number"
								min="1"
								step="1"
								required
								placeholder="e.g., 5"
								value={totalPersonas ?? ''}
								oninput={handleTotalPersonasChange}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
							{#if showFieldErrors && totalPersonasError}
								<p class="text-xs font-medium text-brand">{totalPersonasError}</p>
							{/if}
						</div>
					</div>
				</details>

				<details class="rounded-2xl border border-line bg-white" open>
					<summary class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink">
						AI Personas
					</summary>
					{#if showPersonas}
						{@const personaCount = typeof totalPersonas === 'number' ? totalPersonas : 0}
						<div class="flex flex-col gap-3 border-t border-line-soft px-5 py-5">
							{#each Array.from({ length: personaCount }) as _, index (index)}
								{@const persona = personas[index] ?? createEmptyPersona()}
								{@const personaLabel = getPersonaLabel(persona, `Persona ${index + 1}`)}
								<details class="rounded-xl border border-line-soft bg-cream/40">
									<summary class="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-ink">
										{personaLabel}
									</summary>
									<div class="border-t border-line-soft px-4 py-4">
										<PersonaFields
											{persona}
											errors={showFieldErrors ? rootPersonaErrors[index] : {}}
										/>
									</div>
								</details>
							{/each}
							{#each referredPersonas as item, referredIndex (item.path.join('-'))}
								<details class="rounded-xl border border-line-soft bg-cream/40">
									<summary class="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-ink">
										{item.label} &larr; {item.parentLabel}
									</summary>
									<div class="border-t border-line-soft px-4 py-4">
										<PersonaFields
											persona={resolveReferredPersona(item.path)}
											errors={showFieldErrors ? referredPersonaErrors[referredIndex] : {}}
										/>
									</div>
								</details>
							{/each}
						</div>
					{/if}
				</details>

				{#if displayedError}
					<p class="text-sm font-medium text-brand">{displayedError}</p>
				{/if}
				{#if submitSuccess}
					<p class="text-sm font-medium text-success">{submitSuccess}</p>
				{/if}
				{#if showFieldErrors && hasValidationErrors}
					<p class="text-sm font-medium text-brand">
						Resolve the highlighted fields above before submitting.
					</p>
				{/if}

				<button
					type="submit"
					disabled={isLoadingSource || isSubmitting || hasValidationErrors}
					class="self-start rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{isSubmitting ? 'Submitting…' : 'Submit'}
				</button>
			</form>
		</div>
	</div>
</div>
