<script lang="ts">
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import { apiFetch } from "$lib/api/client.js";
import DestructiveConfirmDialog from "$lib/components/DestructiveConfirmDialog.svelte";
import { ADMIN_ROLE } from "$lib/constants.js";
import type { Api } from "$lib/types.js";

const ROLE_LABELS: Record<Api<"AdminRole">, string> = {
	[ADMIN_ROLE.SUPER]: "Super Admin",
	[ADMIN_ROLE.ADMIN]: "Admin",
};

let admins = $state<Api<"AdminOut">[]>([]);
let isLoading = $state(true);
let listError = $state("");

let email = $state("");
let name = $state("");
let role = $state<Api<"AdminRole">>(ADMIN_ROLE.ADMIN);
let isAdding = $state(false);
let pendingDelete = $state<Api<"AdminOut"> | null>(null);
let isDeleting = $state(false);

async function loadAdmins(): Promise<void> {
	isLoading = true;
	listError = "";
	try {
		admins = await apiFetch<Api<"AdminOut">[]>("/api/admin/admins");
	} catch (err) {
		listError =
			(err instanceof Error && err.message) || "Failed to load admins.";
	} finally {
		isLoading = false;
	}
}

onMount(loadAdmins);

async function handleAdd(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const trimmedEmail = email.trim();
	if (!trimmedEmail) {
		toast("Email is required.");
		return;
	}
	isAdding = true;
	try {
		await apiFetch("/api/admin/admins", {
			method: "POST",
			body: {
				email: trimmedEmail,
				name: name.trim() || null,
				role,
			} satisfies Api<"AddAdminRequest">,
		});
		email = "";
		name = "";
		role = ADMIN_ROLE.ADMIN;
		toast(`Added ${trimmedEmail}.`, { duration: 4000 });
		await loadAdmins();
	} catch (err) {
		toast((err instanceof Error && err.message) || "Failed to add admin.");
	} finally {
		isAdding = false;
	}
}

function requestDelete(admin: Api<"AdminOut">): void {
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
		const result = await apiFetch<Api<"AdminDeletedResponse">>(
			`/api/admin/admins/${admin.id}`,
			{ method: "DELETE" },
		);
		const parts: string[] = [];
		if (result.cases_deleted > 0) {
			parts.push(
				`${result.cases_deleted} case${result.cases_deleted === 1 ? "" : "s"} deleted`,
			);
		}
		if (result.cases_reassigned > 0) {
			parts.push(
				`${result.cases_reassigned} case${result.cases_reassigned === 1 ? "" : "s"} reassigned`,
			);
		}
		toast(
			parts.length > 0
				? `Deleted ${admin.email} — ${parts.join(", ")}.`
				: `Deleted ${admin.email}.`,
			{ duration: 4000 },
		);
		pendingDelete = null;
		await loadAdmins();
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
					<option value={ADMIN_ROLE.ADMIN}>Admin</option>
					<option value={ADMIN_ROLE.SUPER}>Super Admin</option>
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
			{#if isLoading}
				<p class="p-5 text-sm text-stone">Loading admins…</p>
			{:else if listError}
				<p class="p-5 text-sm text-brand">{listError}</p>
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
						{#each admins as admin (admin.id)}
							<tr class="transition hover:bg-cream/60">
								<td class="px-5 py-3 font-medium text-ink">{admin.email}</td>
								<td class="px-5 py-3 text-stone">{admin.name || '—'}</td>
								<td class="px-5 py-3 text-stone">{ROLE_LABELS[admin.role] || admin.role}</td>
								<td class="px-5 py-3 text-right">
									{#if admin.role === ADMIN_ROLE.SUPER}
										<span class="text-sm text-stone-soft">Super admins can't be deleted</span>
									{:else}
										<button
											type="button"
											onclick={() => requestDelete(admin)}
											disabled={isDeleting && pendingDelete?.id === admin.id}
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
