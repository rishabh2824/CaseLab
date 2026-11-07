<script lang="ts">
import { Graph, layout } from "@dagrejs/dagre";
import { Background, type Edge, MarkerType, SvelteFlow } from "@xyflow/svelte";
import "@xyflow/svelte/dist/style.css";
import { pathKey, personaOf } from "#lib/case/fieldPath.js";
import type { CaseGraph } from "#lib/case/graph.svelte.js";
import { type CaseIssue, referralPath } from "#shared/rules.js";
import PersonaNode, { type PersonaFlowNode } from "./PersonaNode.svelte";

type Props = {
	graph: CaseGraph;
	selectedId: string | undefined;
	issues: CaseIssue[];
	disabled: boolean;
	onSelect: (personaId: string) => void;
	onSelectReferral: (fromId: string, toId: string) => void;
};

let { graph, selectedId, issues, disabled, onSelect, onSelectReferral }: Props =
	$props();

// Matches the node card's fixed size in PersonaNode, so dagre lays out what is drawn.
const NODE_WIDTH = 200;
const NODE_HEIGHT = 56;
const nodeTypes = { persona: PersonaNode };

let nodes = $state.raw<PersonaFlowNode[]>([]);
let edges = $state.raw<Edge[]>([]);

// Lays the personas out left to right in referral order and rebuilds the diagram whenever the graph changes. Runs before the DOM updates, so a remounted diagram fits the new layout rather than the old one.
$effect.pre(() => {
	const dagreGraph = new Graph()
		.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 72 })
		.setDefaultEdgeLabel(() => ({}));
	for (const persona of graph.personas) {
		dagreGraph.setNode(persona.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}
	for (const referral of graph.referrals) {
		dagreGraph.setEdge(referral.fromId, referral.toId);
	}
	layout(dagreGraph);

	nodes = graph.personas.map((persona) => {
		const { x, y } = dagreGraph.node(persona.id);
		return {
			id: persona.id,
			type: "persona",
			position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
			data: {
				name: persona.name,
				role: persona.role,
				isRoot: graph.roots.includes(persona.id),
				isSelected: persona.id === selectedId,
				hasErrors: issues.some((issue) => personaOf(issue.path) === persona.id),
			},
		};
	});
	edges = graph.referrals.map((referral) => {
		const key = pathKey(referralPath(referral.fromId, referral.toId));
		const hasIssue = issues.some((issue) => pathKey(issue.path) === key);
		return {
			id: `${referral.fromId}->${referral.toId}`,
			source: referral.fromId,
			target: referral.toId,
			markerEnd: {
				type: MarkerType.ArrowClosed,
				color: hasIssue ? "var(--color-brand)" : undefined,
			},
			// A referral with no condition is drawn dashed, as a nudge to fill it in, and red once it is stopping a save.
			style: referral.conditions.trim()
				? undefined
				: `stroke-dasharray: 5 4${hasIssue ? "; stroke: var(--color-brand)" : ""}`,
		};
	});
});

// Changes whenever personas or referrals are added or removed, so the diagram refits to its new shape.
const shapeKey = $derived(`${graph.personas.length}:${graph.referrals.length}`);
</script>

<div class="h-80 overflow-hidden rounded-xl border border-line-soft bg-cream/40">
	{#key shapeKey}
		<SvelteFlow
			bind:nodes
			bind:edges
			{nodeTypes}
			fitView
			fitViewOptions={{ maxZoom: 1 }}
			proOptions={{ hideAttribution: true }}
			zoomOnScroll={false}
			preventScrolling={false}
			nodesDraggable={false}
			elementsSelectable={false}
			nodesConnectable={!disabled}
			deleteKey={null}
			isValidConnection={(connection) => graph.canLink(connection.source, connection.target)}
			onconnect={(connection) => graph.link(connection.source, connection.target)}
			onnodeclick={({ node }) => onSelect(node.id)}
			onedgeclick={({ edge }) => onSelectReferral(edge.source, edge.target)}
		>
			<Background />
		</SvelteFlow>
	{/key}
</div>
