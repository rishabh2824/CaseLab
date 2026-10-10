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

	const { dropped } = splitCyclicEdges(ids, referrals);
	if (dropped.length > 0)
		return `Referral cycle detected involving persona id: ${dropped[0]!.toId}`;

	const reachable = reachableFrom(roots, referrals);
	const unreachable = personas.find((persona) => !reachable.has(persona.id));
	if (unreachable) {
		const name = unreachable.name.trim();
		return `Persona ${unreachable.id}${name ? ` (${name})` : ""} isn't connected to any root persona.`;
	}
	return null;
}

// Walks the graph depth-first from each id in order and splits the edges into those that are kept and those that would close a cycle.
export function splitCyclicEdges<E extends GraphEdge>(
	ids: string[],
	edges: E[],
): { accepted: E[]; dropped: E[] } {
	const edgesFrom = new Map<string, E[]>();
	for (const edge of edges) {
		const outgoing = edgesFrom.get(edge.fromId) ?? [];
		outgoing.push(edge);
		edgesFrom.set(edge.fromId, outgoing);
	}

	const UNVISITED = 0;
	const IN_PROGRESS = 1;
	const DONE = 2;
	const state = new Map<string, number>(ids.map((id) => [id, UNVISITED]));
	const accepted: E[] = [];
	const dropped: E[] = [];

	const stack: { node: string; edge: number }[] = [];
	for (const startId of ids) {
		if (state.get(startId) !== UNVISITED) continue;
		state.set(startId, IN_PROGRESS);
		stack.push({ node: startId, edge: 0 });

		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const outgoing = edgesFrom.get(frame.node) ?? [];
			if (frame.edge >= outgoing.length) {
				state.set(frame.node, DONE);
				stack.pop();
				continue;
			}
			const edge = outgoing[frame.edge]!;
			frame.edge += 1;
			if (state.get(edge.toId) === IN_PROGRESS) {
				dropped.push(edge);
				continue;
			}
			accepted.push(edge);
			if (state.get(edge.toId) === UNVISITED) {
				state.set(edge.toId, IN_PROGRESS);
				stack.push({ node: edge.toId, edge: 0 });
			}
		}
	}
	return { accepted, dropped };
}
