import { reachableFrom, rootIds } from "../../../convex/lib/caseGraph.js";
import { getPersonaFieldErrors } from "../../../convex/lib/caseRules.js";
import type { GraphData, Persona, ReferralEdge } from "../types.js";
import {
	createEmptyPersona,
	createEmptyReferral,
	hasFieldErrors,
	personasById,
} from "./draft.js";

export type GraphValidation = {
	rootsError: string | null;
	hasErrors: boolean;
};

export class CaseGraph {
	personas = $state<Persona[]>([]);
	referrals = $state<ReferralEdge[]>([]);

	byId: Map<string, Persona> = $derived(personasById(this.personas));
	// The personas nobody refers to: available from the start.
	roots: string[] = $derived(
		rootIds(
			this.personas.map((persona) => persona.id),
			this.referrals,
		),
	);

	validation: GraphValidation = $derived.by(() => {
		const rootsError =
			this.personas.length < 1 ? "At least 1 persona is required" : null;
		const hasAnyPersonaError = this.personas.some((persona) =>
			hasFieldErrors(getPersonaFieldErrors(persona)),
		);
		return {
			rootsError,
			hasErrors: Boolean(rootsError) || hasAnyPersonaError,
		};
	});

	// Replaces the graph's personas and referrals.
	load(input: GraphData): void {
		this.personas = input.personas;
		this.referrals = input.referrals;
	}

	// Adds a new blank root persona and returns it.
	addRoot(overrides?: Partial<Persona>): Persona {
		const persona = createEmptyPersona(overrides);
		this.personas = [...this.personas, persona];
		return persona;
	}

	// Returns the ids removing the persona would delete: the persona itself and everyone reachable only through it.
	removalSet(personaId: string): Set<string> {
		const stillReachable = reachableFrom(
			this.roots.filter((id) => id !== personaId),
			this.referrals.filter(
				(referral) =>
					referral.fromId !== personaId && referral.toId !== personaId,
			),
		);
		return new Set(
			this.personas
				.map((persona) => persona.id)
				.filter((id) => !stillReachable.has(id)),
		);
	}

	// Removes a persona, the referrals touching it and everyone reachable only through it.
	removePersona(personaId: string): void {
		this.#applyRemoval(this.removalSet(personaId));
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

	// Whether one existing persona may refer to another: not itself, not a starting persona, not twice, and never closing a loop.
	canLink(fromId: string, toId: string): boolean {
		return (
			fromId !== toId &&
			this.byId.has(fromId) &&
			this.byId.has(toId) &&
			!this.roots.includes(toId) &&
			!this.referrals.some(
				(referral) => referral.fromId === fromId && referral.toId === toId,
			) &&
			!reachableFrom([toId], this.referrals).has(fromId)
		);
	}

	// Adds a referral between two existing personas, when canLink allows it.
	link(fromId: string, toId: string): void {
		if (!this.canLink(fromId, toId)) return;
		this.referrals = [...this.referrals, createEmptyReferral({ fromId, toId })];
	}

	// Removes one referral, along with anyone it leaves unreachable. Without that, the persona it introduced would become a starting persona.
	unlink(fromId: string, toId: string): void {
		const roots = this.roots;
		this.referrals = this.referrals.filter(
			(referral) => !(referral.fromId === fromId && referral.toId === toId),
		);
		const reachable = reachableFrom(roots, this.referrals);
		this.#applyRemoval(
			new Set(
				this.personas
					.map((persona) => persona.id)
					.filter((id) => !reachable.has(id)),
			),
		);
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
