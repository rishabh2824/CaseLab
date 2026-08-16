// Owns the in-memory persona/referral graph a case form edits — personas and
// referral edges as sibling arrays (see types.ts). Dirty-tracking lives in
// CaseForm's snapshot comparison, not here (see CaseForm.svelte).
import type { Persona, ReferralEdge } from "../types.js";
import {
	createEmptyPersona,
	createEmptyReferral,
	getPersonaFieldErrors,
	hasFieldErrors,
	personasById,
	reachableFrom,
	referredWithParents as referredWithParentsOf,
} from "./draft.js";

export type GraphInput = {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
};

export type GraphValidation = {
	rootsError: string | null;
	hasErrors: boolean;
};

export class CaseGraph {
	personas = $state<Persona[]>([]);
	referrals = $state<ReferralEdge[]>([]);
	roots = $state<string[]>([]);

	// $derived (memoized against personas/referrals/roots), not a plain getter:
	// CaseGraphEditor.svelte and PersonaFields.svelte read these once per
	// persona/referral inside {#each} loops, so a plain getter rebuilt the
	// whole Map / re-walked the whole graph on every one of those accesses —
	// real cost for a 30-persona case. ReadOnlyPersonaCard.svelte already uses
	// this pattern for the same computations outside the class.
	byId: Map<string, Persona> = $derived(personasById(this.personas));
	referredWithParents = $derived(
		referredWithParentsOf(this.personas, this.referrals, this.roots),
	);

	// $derived, same as byId/referredWithParents above — one memoized signal
	// shared by every reader (CaseForm.svelte and CaseGraphEditor.svelte both
	// read graph.validation), instead of each call site re-walking all N
	// personas on its own. Per-persona field errors are no longer computed
	// here: PersonaFields.svelte derives its own from just its own persona,
	// so editing one persona no longer invalidates every other one's errors.
	validation: GraphValidation = $derived.by(() => {
		const rootsError =
			this.roots.length < 1 ? "At least 1 persona is required" : null;
		const hasAnyPersonaError = this.personas.some((persona) =>
			hasFieldErrors(getPersonaFieldErrors(persona)),
		);
		return {
			rootsError,
			hasErrors: Boolean(rootsError) || hasAnyPersonaError,
		};
	});

	load(input: GraphInput): void {
		this.personas = input.personas;
		this.referrals = input.referrals;
		this.roots = input.roots;
	}

	applyImport(input: GraphInput): void {
		this.load(input);
	}

	addRoot(overrides?: Partial<Persona>): Persona {
		const persona = createEmptyPersona(overrides);
		this.personas = [...this.personas, persona];
		this.roots = [...this.roots, persona.id];
		return persona;
	}

	// Discards a root's whole subtree — every persona only reachable from it,
	// not also reachable from some other kept root or referral.
	removeSubtree(rootId: string): void {
		const keptRoots = this.roots.filter((id) => id !== rootId);
		const stillReachable = reachableFrom(keptRoots, this.referrals);
		const toRemove = new Set(
			[...reachableFrom([rootId], this.referrals)].filter(
				(id) => !stillReachable.has(id),
			),
		);
		this.#applyRemoval(toRemove);
		this.roots = keptRoots;
	}

	addReferral(fromPersonaId: string): {
		persona: Persona;
		referral: ReferralEdge;
	} {
		const persona = createEmptyPersona();
		const referral = createEmptyReferral({
			from_id: fromPersonaId,
			to_id: persona.id,
		});
		this.personas = [...this.personas, persona];
		this.referrals = [...this.referrals, referral];
		return { persona, referral };
	}

	// Removes personaId's referral edges into targetIds, then cascade-deletes
	// each removed target's own subtree — unless a target is still reachable
	// some other way once those edges are gone (e.g. a second parent).
	removeReferralsFrom(personaId: string, targetIds: Iterable<string>): void {
		const targets = new Set(targetIds);
		this.referrals = this.referrals.filter(
			(referral) =>
				!(referral.from_id === personaId && targets.has(referral.to_id)),
		);
		const stillReachable = reachableFrom(this.roots, this.referrals);
		const toRemove = new Set(
			[...reachableFrom([...targets], this.referrals)].filter(
				(id) => !stillReachable.has(id),
			),
		);
		this.#applyRemoval(toRemove);
	}

	removeReferral(referral: ReferralEdge): void {
		this.removeReferralsFrom(referral.from_id, [referral.to_id]);
	}

	#applyRemoval(toRemove: Set<string>): void {
		if (toRemove.size === 0) return;
		this.personas = this.personas.filter(
			(persona) => !toRemove.has(persona.id),
		);
		this.referrals = this.referrals.filter(
			(referral) =>
				!toRemove.has(referral.from_id) && !toRemove.has(referral.to_id),
		);
	}
}
