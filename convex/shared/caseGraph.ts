// Pure graph helpers shared by the Convex backend and the browser. No imports, so the client bundle stays small.

export type GraphEdge = { fromId: string; toId: string };

// Returns every persona id reachable from the start ids by following referrals, safely handling cycles. Self-contained, because the exported case form embeds its source.
export const reachableFrom = (
	startIds: string[],
	referrals: { fromId: string; toId: string }[],
): Set<string> => {
	const reachable = new Set(startIds);
	const queue = [...startIds];
	while (queue.length > 0) {
		const currentId = queue.shift() as string;
		for (const referral of referrals) {
			if (referral.fromId === currentId && !reachable.has(referral.toId)) {
				reachable.add(referral.toId);
				queue.push(referral.toId);
			}
		}
	}
	return reachable;
};

// Returns the ids nobody refers to: the root personas, available from the start. In a graph without cycles every other persona is reachable from one of them.
export function rootIds(ids: string[], edges: GraphEdge[]): string[] {
	const referred = new Set(edges.map((edge) => edge.toId));
	return ids.filter((id) => !referred.has(id));
}

// Checks the shape of a case's persona graph and returns the first problem as a message, or null when it is sound. Shared by the server (on save) and the client (on import).
export function validateStructure({
	personas,
	referrals,
}: {
	personas: { id: string }[];
	referrals: GraphEdge[];
}): string | null {
	if (personas.length === 0) return "A case needs at least one persona.";

	const ids = personas.map((persona) => persona.id);
	if (hasCycle(ids, referrals)) return "Referrals can't form a cycle.";
	return null;
}

// Whether the referrals contain a cycle, by repeatedly peeling off personas nobody refers to: anything left over sits on or behind a loop.
export function hasCycle(ids: string[], edges: GraphEdge[]): boolean {
	const incoming = new Map(ids.map((id) => [id, 0]));
	for (const edge of edges)
		incoming.set(edge.toId, (incoming.get(edge.toId) ?? 0) + 1);
	const ready = rootIds(ids, edges);
	let peeled = 0;
	while (ready.length > 0) {
		const currentId = ready.pop() as string;
		peeled += 1;
		for (const edge of edges) {
			if (edge.fromId !== currentId) continue;
			const remaining = (incoming.get(edge.toId) as number) - 1;
			incoming.set(edge.toId, remaining);
			if (remaining === 0) ready.push(edge.toId);
		}
	}
	return peeled < ids.length;
}
