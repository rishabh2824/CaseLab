import { rootIds } from "../shared/caseGraph";
import type {
	CaseStructure,
	PersonaPayload,
	ReferralEdgePayload,
} from "../shared/validators";

export type PersonaGraph = {
	personas: Map<string, PersonaPayload>;
	referrals: ReferralEdgePayload[];
	roots: string[];
};

// Turns a case structure into a graph of personas, referral edges and name-sorted roots (the personas nobody refers to). The structure is already validated on write.
export function flattenPersonas(structure: CaseStructure): PersonaGraph {
	const personas = new Map(structure.personas.map((p) => [p.id, p]));
	const roots = rootIds(
		structure.personas.map((p) => p.id),
		structure.referrals,
	).sort((a, b) => personas.get(a)!.name.localeCompare(personas.get(b)!.name));
	return { personas, referrals: structure.referrals, roots };
}
