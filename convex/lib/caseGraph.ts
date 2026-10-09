// Pure graph helpers shared by the Convex backend and the browser. No imports, so the client bundle stays small.

export type GraphEdge = { fromId: string; toId: string };

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
