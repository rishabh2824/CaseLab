<script lang="ts">
import { useMutation, useQuery } from "convex-svelte";
import { makeFunctionReference } from "convex/server";
import { toast } from "svelte-sonner";
import DestructiveConfirmDialog from "$lib/components/DestructiveConfirmDialog.svelte";

// String-based references (not generated `api` imports): the convex/ project lives at
// the repo root, outside this Vite project's root -- see AdminAuth.svelte for why.
const listAllRef = makeFunctionReference<"query">("api/admins:listAll");
const createRef = makeFunctionReference<"mutation">("api/admins:create");
const deleteRef = makeFunctionReference<"mutation">("api/admins:deleteWithCascade");

type AdminRole = "super" | "admin";
type AdminRow = { _id: string; email: string; name?: string; role: AdminRole };

const ROLE_LABELS: Record<AdminRole, string> = {
	super: "Super Admin",
	admin: "Admin",
};

const adminsQuery = useQuery(listAllRef, {});
const admins = $derived((adminsQuery.data ?? []) as AdminRow[]);
const createAdmin = useMutation(createRef);
const deleteAdmin = useMutation(deleteRef);

let email = $state("");
let name = $state("");
let role = $state<AdminRole>("admin");
let isAdding = $state(false);
let pendingDelete = $state<AdminRow | null>(null);
let isDeleting = $state(false);

async function handleAdd(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const trimmedEmail = email.trim();
	if (!trimmedEmail) {
		toast("Email is required.");
		return;
	}
	isAdding = true;
	try {
		await createAdmin({ email: trimmedEmail, name: name.trim() || undefined, role });
		email = "";
		name = "";
		role = "admin";
		toast(`Added ${trimmedEmail}.`, { duration: 4000 });
	} catch (err) {
		toast((err instanceof Error && err.message) || "Failed to add admin.");
	} finally {
		isAdding = false;
	}
}

function requestDelete(admin: AdminRow): void {
	pendingDelete = admin;
}

function cancelDelete(): void {
	pendingDelete = null;
}

async function confirmDelete(): Promise<void> {
	const admin = pendingDelete;
	if (!admin) return;
	isDeleting = true;
	try {
		const result = await deleteAdmin({ adminId: admin._id });
		const parts: string[] = [];
		if (result.casesDeleted > 0) {
			parts.push(`${result.casesDeleted} case${result.casesDeleted === 1 ? "" : "s"} deleted`);
		}
		if (result.casesReassigned > 0) {
			parts.push(
				`${result.casesReassigned} case${result.casesReassigned === 1 ? "" : "s"} reassigned`,
			);
		}
		toast(
			parts.length > 0
				? `Deleted ${admin.email} — ${parts.join(", ")}.`
				: `Deleted ${admin.email}.`,
			{ duration: 4000 },
		);
		pendingDelete = null;
	} catch (err) {
		toast((err instanceof Error && err.message) || "Failed to delete admin.");
	} finally {
		isDeleting = false;
	}
}
</script>

<div class="relative min-h-screen overflow-hidden bg-parchment px-6 py-10">
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
	<div class="relative z-10 mx-auto max-w-4xl">
		<div class="flex items-center gap-3">
			<span class="h-px w-8 bg-line"></span>
			<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
				Super Admin
			</p>
		</div>
		<h1 class="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
			Manage admins
		</h1>
		<p class="mt-4 max-w-xl text-sm leading-6 text-stone">
			Add an admin by email. Deleting an admin deletes any case they own with no collaborators, and
			reassigns ownership of cases they own with collaborators to the longest-standing collaborator.
		</p>

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
				<label for="admin-name" class="text-xs font-medium text-stone-soft">
					Name (optional)
				</label>
				<input
					id="admin-name"
					type="text"
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
			<button
				type="submit"
				disabled={isAdding}
				class="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
			>
				{isAdding ? 'Adding…' : 'Add admin'}
			</button>
		</form>

		<div class="mt-8 overflow-hidden rounded-2xl border border-line bg-white shadow-soft">
			{#if adminsQuery.isLoading}
				<p class="p-5 text-sm text-stone">Loading admins…</p>
			{:else if adminsQuery.error}
				<p class="p-5 text-sm text-brand">
					{adminsQuery.error.message || "Failed to load admins."}
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
								<td class="px-5 py-3 text-stone">{admin.name || '—'}</td>
								<td class="px-5 py-3 text-stone">{ROLE_LABELS[admin.role] || admin.role}</td>
								<td class="px-5 py-3 text-right">
									{#if admin.role === "super"}
										<span class="text-sm text-stone-soft">Super admins can't be deleted</span>
									{:else}
										<button
											type="button"
											onclick={() => requestDelete(admin)}
											disabled={isDeleting && pendingDelete?._id === admin._id}
											class="text-sm font-semibold text-brand transition hover:text-brand-dark disabled:opacity-60"
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

<DestructiveConfirmDialog
	bind:open={() => pendingDelete !== null, (isOpen) => { if (!isOpen) pendingDelete = null }}
	title={pendingDelete ? `Delete ${pendingDelete.email}?` : ""}
	description="This cannot be undone. Any case they own with no collaborators is deleted; a case they own that has collaborators is reassigned to the longest-standing collaborator."
	confirming={isDeleting}
	onConfirm={confirmDelete}
	onCancel={cancelDelete}
/>
