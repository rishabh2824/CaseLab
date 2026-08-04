// Owns the in-memory persona/referral graph a case form edits — personas and
// referral edges as sibling arrays (see types.ts), plus dirty-tracking.
import type { Persona, PersonaFieldErrors, ReferralEdge } from "../types.js";
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
	personaErrors: Record<string, PersonaFieldErrors>;
	hasErrors: boolean;
};

export class CaseGraph {
	personas = $state<Persona[]>([]);
	referrals = $state<ReferralEdge[]>([]);
	roots = $state<string[]>([]);

	#dirty = $state(false);
	get isDirty(): boolean {
		return this.#dirty;
	}

	get byId(): Map<string, Persona> {
		return personasById(this.personas);
	}

	get referredWithParents() {
		return referredWithParentsOf(this.personas, this.referrals, this.roots);
	}

	validate(): GraphValidation {
		const rootsError =
			this.roots.length < 1 ? "At least 1 persona is required" : null;
		const personaErrors: Record<string, PersonaFieldErrors> = {};
		for (const persona of this.personas) {
			personaErrors[persona.id] = getPersonaFieldErrors(persona);
		}
		const hasAnyPersonaError =
			Object.values(personaErrors).some(hasFieldErrors);
		return {
			rootsError,
			personaErrors,
			hasErrors: Boolean(rootsError) || hasAnyPersonaError,
		};
	}

	load(input: GraphInput): void {
		this.personas = input.personas;
		this.referrals = input.referrals;
		this.roots = input.roots;
		this.#dirty = false;
	}

	applyImport(input: GraphInput): void {
		this.personas = input.personas;
		this.referrals = input.referrals;
		this.roots = input.roots;
		this.#dirty = true;
	}

	markSaved(): void {
		this.#dirty = false;
	}

	// Passed by bare reference into PersonaFields, so field-level edits that
	// never go through a mutator below (bind:value, files.push, etc.) still
	// register as dirty.
	touch = (): void => {
		this.#dirty = true;
	};

	addRoot(overrides?: Partial<Persona>): Persona {
		const persona = createEmptyPersona(overrides);
		this.personas = [...this.personas, persona];
		this.roots = [...this.roots, persona.id];
		this.#dirty = true;
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
		this.#dirty = true;
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
		this.#dirty = true;
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
		this.#dirty = true;
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

export function createCaseGraph(): CaseGraph {
	return new CaseGraph();
}
