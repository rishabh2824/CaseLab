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

// Checks the shape of a case's persona graph and returns the first problem as a message, or null when it is sound. Shared by the server (on save) and the client (on import).
export function validateStructure({
	personas,
	referrals,
	roots,
}: {
	personas: { id: string; name: string }[];
	referrals: GraphEdge[];
	roots: string[];
}): string | null {
	if (personas.length === 0) return "A case needs at least one persona.";
	if (roots.length === 0)
		return "A case needs at least one root persona to start from.";

	const ids = personas.map((persona) => persona.id);
	const known = new Set<string>();
	const duplicates = new Set<string>();
	for (const id of ids) (known.has(id) ? duplicates : known).add(id);
	if (duplicates.size > 0)
		return `Duplicate persona id(s): ${[...duplicates].sort().join(", ")}`;

	const seenRoots = new Set<string>();
	for (const rootId of roots) {
		if (!known.has(rootId)) return `Unknown root persona id: ${rootId}`;
		if (seenRoots.has(rootId)) return `Duplicate root persona id: ${rootId}`;
		seenRoots.add(rootId);
	}

	const seenReferrals = new Set<string>();
	for (const referral of referrals) {
		if (!known.has(referral.fromId))
			return `Unknown referral fromId: ${referral.fromId}`;
		if (!known.has(referral.toId))
			return `Unknown referral toId: ${referral.toId}`;
		const key = JSON.stringify([referral.fromId, referral.toId]);
		if (seenReferrals.has(key))
			return `Duplicate referral: ${referral.fromId} -> ${referral.toId}`;
		seenReferrals.add(key);
	}

	if (hasCycle(ids, referrals)) return "Referrals can't form a cycle.";

	const reachable = reachableFrom(roots, referrals);
	const unreachable = personas.find((persona) => !reachable.has(persona.id));
	if (unreachable) {
		const name = unreachable.name.trim();
		return `Persona ${unreachable.id}${name ? ` (${name})` : ""} isn't connected to any root persona.`;
	}
	return null;
}

// Whether the referrals contain a cycle, by repeatedly peeling off personas nobody refers to: anything left over sits on or behind a loop.
export function hasCycle(ids: string[], edges: GraphEdge[]): boolean {
	const incoming = new Map(ids.map((id) => [id, 0]));
	for (const edge of edges)
		incoming.set(edge.toId, (incoming.get(edge.toId) ?? 0) + 1);
	const ready = ids.filter((id) => incoming.get(id) === 0);
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
