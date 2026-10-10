import { reachableFrom } from "../../../convex/lib/caseGraph.js";
import { getPersonaFieldErrors } from "../../../convex/lib/caseRules.js";
import type { Persona, ReferralEdge } from "../types.js";
import {
	createEmptyPersona,
	createEmptyReferral,
	hasFieldErrors,
	personasById,
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

	byId: Map<string, Persona> = $derived(personasById(this.personas));
	referredWithParents = $derived(
		referredWithParentsOf(this.personas, this.referrals, this.roots),
	);

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

	// Replaces the graph's personas, referrals and roots.
	load(input: GraphInput): void {
		this.personas = input.personas;
		this.referrals = input.referrals;
		this.roots = input.roots;
	}

	// Adds a new blank root persona and returns it.
	addRoot(overrides?: Partial<Persona>): Persona {
		const persona = createEmptyPersona(overrides);
		this.personas = [...this.personas, persona];
		this.roots = [...this.roots, persona.id];
		return persona;
	}

	// Removes a root and every persona that was reachable only through it.
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

	// Adds a blank referred persona linked from the given persona and returns both.
	addReferral(fromPersonaId: string): {
		persona: Persona;
		referral: ReferralEdge;
	} {
		const persona = createEmptyPersona();
		const referral = createEmptyReferral({
			fromId: fromPersonaId,
			toId: persona.id,
		});
		this.personas = [...this.personas, persona];
		this.referrals = [...this.referrals, referral];
		return { persona, referral };
	}

	// Removes a persona's referrals to the given targets, along with anything that becomes unreachable.
	removeReferralsFrom(personaId: string, targetIds: Iterable<string>): void {
		const targets = new Set(targetIds);
		this.referrals = this.referrals.filter(
			(referral) =>
				!(referral.fromId === personaId && targets.has(referral.toId)),
		);
		const stillReachable = reachableFrom(this.roots, this.referrals);
		const toRemove = new Set(
			[...reachableFrom([...targets], this.referrals)].filter(
				(id) => !stillReachable.has(id),
			),
		);
		this.#applyRemoval(toRemove);
	}

	// Deletes the given personas and any referrals that touch them.
	#applyRemoval(toRemove: Set<string>): void {
		if (toRemove.size === 0) return;
		this.personas = this.personas.filter(
			(persona) => !toRemove.has(persona.id),
		);
		this.referrals = this.referrals.filter(
			(referral) =>
				!toRemove.has(referral.fromId) && !toRemove.has(referral.toId),
		);
	}
}
