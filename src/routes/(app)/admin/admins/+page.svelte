<script lang="ts">
import { useMutation, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { api } from "#convex/api.js";
import type { Doc } from "#convex/dataModel.js";
import { getViewerContext } from "#lib/adminViewer.js";
import Button from "#lib/components/ui/Button.svelte";
import DeleteDialog from "#lib/components/ui/DeleteDialog.svelte";
import PageHeader from "#lib/components/ui/PageHeader.svelte";
import { getErrorMessage } from "#lib/errors.js";
import type { AdminRole } from "#lib/types.js";
import { goto } from "$app/navigation";

const ROLE_LABELS: Record<AdminRole, string> = {
	super: "Super Admin",
	admin: "Admin",
};

const adminsQuery = useQuery(api.admins.listAll, {});
const admins = $derived(adminsQuery.data ?? []);
const createAdmin = useMutation(api.admins.create);
const deleteAdmin = useMutation(api.admins.deleteWithCascade);

const viewer = getViewerContext();
const isSuperAdmin = $derived(viewer.data?.role === "super");
$effect(() => {
	if (viewer.isLoading) return;
	if (!isSuperAdmin) goto("/admin", { replaceState: true });
});

let email = $state("");
let name = $state("");
let role = $state<AdminRole>("admin");
let isAdding = $state(false);
let pendingDelete = $state<Doc<"admins"> | null>(null);

// Submits the add-admin form, showing a toast for the result. The server validates the fields.
async function handleAdd(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	isAdding = true;
	try {
		const admin = await createAdmin({ email, name, role });
		email = "";
		name = "";
		role = "admin";
		toast(`Added ${admin.email}.`, { duration: 4000 });
	} catch (err) {
		toast(getErrorMessage(err, "Failed to add admin."));
	} finally {
		isAdding = false;
	}
}

// Deletes an admin and toasts how many of their cases were deleted.
async function handleDelete(admin: Doc<"admins">): Promise<void> {
	const result = await deleteAdmin({ adminId: admin._id });
	toast(
		result.casesDeleted > 0
			? `Deleted ${admin.email} — ${result.casesDeleted} case${result.casesDeleted === 1 ? "" : "s"} deleted.`
			: `Deleted ${admin.email}.`,
		{ duration: 4000 },
	);
}
</script>

{#if isSuperAdmin}
<div class="px-6 py-10">
	<div class="relative z-10 mx-auto max-w-4xl">
		<PageHeader
			eyebrow="Super Admin"
			title="Manage admins"
			description="Add an admin by email. Deleting an admin also deletes every case they own."
		/>

		<form
			onsubmit={handleAdd}
			class="mt-10 flex flex-wrap items-end gap-4 rounded-2xl border border-line bg-white p-6 shadow-soft"
		>
			<div class="flex min-w-[220px] flex-1 flex-col gap-1.5">
				<label for="admin-email" class="text-xs font-medium text-stone-soft">Email</label>
				<input
					id="admin-email"
					type="email"
					required
					bind:value={email}
					class="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
					placeholder="name@wisc.edu"
				/>
			</div>
			<div class="flex min-w-[160px] flex-1 flex-col gap-1.5">
				<label for="admin-name" class="text-xs font-medium text-stone-soft">Name</label>
				<input
					id="admin-name"
					type="text"
					required
					bind:value={name}
					class="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
					placeholder="Jane Doe"
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<label for="admin-role" class="text-xs font-medium text-stone-soft">Role</label>
				<select
					id="admin-role"
					bind:value={role}
					class="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
				>
					<option value="admin">Admin</option>
					<option value="super">Super Admin</option>
				</select>
			</div>
			<Button type="submit" variant="primary" disabled={isAdding}>
				{isAdding ? 'Adding…' : 'Add admin'}
			</Button>
		</form>

		<div class="mt-8 overflow-hidden rounded-2xl border border-line bg-white shadow-soft">
			{#if adminsQuery.isLoading}
				<p class="p-5 text-sm text-stone">Loading admins…</p>
			{:else if adminsQuery.error}
				<p class="p-5 text-sm text-brand">
					{getErrorMessage(adminsQuery.error, "Failed to load admins.")}
				</p>
			{:else if admins.length === 0}
				<p class="p-5 text-sm text-stone">No admins yet.</p>
			{:else}
				<table class="w-full text-left text-sm">
					<thead
						class="border-b border-line bg-cream font-mono text-[11px] uppercase tracking-[0.14em] text-stone-soft"
					>
						<tr>
							<th class="px-5 py-3 font-medium">Email</th>
							<th class="px-5 py-3 font-medium">Name</th>
							<th class="px-5 py-3 font-medium">Role</th>
							<th class="px-5 py-3 font-medium"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-line-soft">
						{#each admins as admin (admin._id)}
							<tr class="transition hover:bg-cream/60">
								<td class="px-5 py-3 font-medium text-ink">{admin.email}</td>
								<td class="px-5 py-3 text-stone">{admin.name}</td>
								<td class="px-5 py-3 text-stone">{ROLE_LABELS[admin.role]}</td>
								<td class="px-5 py-3 text-right">
									{#if admin.role === "super"}
										<span class="text-sm text-stone-soft">Super admins can't be deleted</span>
									{:else}
										<button
											type="button"
											onclick={() => (pendingDelete = admin)}
											class="text-sm font-semibold text-brand transition hover:text-brand-dark"
										>
											Delete
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</div>
</div>
{/if}

<DeleteDialog
	bind:item={pendingDelete}
	title={(admin) => `Delete ${admin.email}?`}
	description="This cannot be undone. Every case they own is deleted, including cases shared with collaborators."
	failureMessage="Failed to delete admin."
	onDelete={handleDelete}
/>
