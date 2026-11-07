<script lang="ts">
import { LeaveGuard } from "../../src/lib/case/leaveGuard.svelte.js";

type SaveResult = { ok: true } | { ok: false; error: string };

// Builds a LeaveGuard during component setup, as the case form does, and hands it to the test.
let {
	isDirty,
	save,
	onReady,
}: {
	isDirty: () => boolean;
	save: () => Promise<SaveResult>;
	onReady: (guard: LeaveGuard) => void;
} = $props();

// svelte-ignore state_referenced_locally
onReady(
	new LeaveGuard(
		() => isDirty(),
		() => save(),
	),
);
</script>
