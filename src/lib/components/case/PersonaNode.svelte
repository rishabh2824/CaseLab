<script module lang="ts">
import type { Node } from "@xyflow/svelte";

export type PersonaNodeData = {
	name: string;
	role: string;
	isRoot: boolean;
	isSelected: boolean;
	hasErrors: boolean;
};

export type PersonaFlowNode = Node<PersonaNodeData, "persona">;
</script>

<script lang="ts">
import {
	Handle,
	type NodeProps,
	Position,
	useConnection,
} from "@xyflow/svelte";

let { data }: NodeProps<PersonaFlowNode> = $props();

const connection = useConnection();

// Svelte Flow's default handles are tiny dots, too small to start a drag from.
const HANDLE_CLASS = "size-3! border-2! border-white! bg-stone-soft!";
// An invisible handle over the whole card.
const DROP_ZONE_CLASS =
	"inset-0! size-full! transform-none! rounded-xl! border-0! bg-transparent!";
</script>

<!-- Starting personas take no incoming referrals, so they get no target handle. -->
{#if !data.isRoot}
	<Handle type="target" position={Position.Left} class={HANDLE_CLASS} />
{/if}
<div
	class="flex h-14 w-50 items-center gap-2.5 rounded-xl border bg-white px-3 shadow-sm transition {data.isSelected ? 'border-ink ring-4 ring-ink/10' : data.hasErrors ? 'border-brand' : 'border-line hover:border-stone-soft'}"
>
	<span
		class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold {data.isRoot ? 'bg-brand text-white' : 'bg-cream text-ink-soft'}"
		aria-hidden="true"
	>
		{data.name.trim().charAt(0).toUpperCase() || '?'}
	</span>
	<span class="min-w-0 flex-1 text-left">
		<span class="block truncate text-sm font-semibold text-ink">{data.name.trim() || 'Unnamed persona'}</span>
		<span class="block truncate text-xs text-stone-soft">{data.role.trim() || (data.isRoot ? 'Starting persona' : 'Referred persona')}</span>
	</span>
	{#if data.hasErrors}
		<span class="h-2 w-2 shrink-0 rounded-full bg-brand" title="Needs attention"></span>
	{/if}
</div>
<!-- Lets an arrow land anywhere on the card. Only there during a drag, because it would otherwise swallow clicks on the card. -->
{#if !data.isRoot && connection.current.inProgress}
	<Handle
		id="card"
		type="target"
		position={Position.Left}
		isConnectableStart={false}
		class={DROP_ZONE_CLASS}
	/>
{/if}
<Handle type="source" position={Position.Right} class={HANDLE_CLASS} />
