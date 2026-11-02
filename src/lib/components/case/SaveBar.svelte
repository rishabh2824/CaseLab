<script lang="ts">
import { Popover } from "bits-ui";
import { pathKey } from "#lib/case/fieldPath.js";
import type { CaseIssue } from "#shared/rules.js";
import Button from "../ui/Button.svelte";

type Props = {
	issues: CaseIssue[];
	issuesLabel: string;
	status: string;
	saving: boolean;
	open: boolean;
	onGoToIssue: (issue: CaseIssue) => void;
};

let {
	issues,
	issuesLabel,
	status,
	saving,
	open = $bindable(),
	onGoToIssue,
}: Props = $props();
</script>

<div class="sticky bottom-0 z-10 -mx-8 -mb-8 flex items-center justify-between gap-4 rounded-b-2xl border-t border-line bg-white px-8 py-4">
	<p class="text-xs text-stone-soft">{status}</p>
	<div class="flex items-center gap-4">
		{#if issues.length > 0}
			<Popover.Root bind:open>
				<Popover.Trigger class="text-sm font-semibold text-brand underline underline-offset-2">
					{issuesLabel}
				</Popover.Trigger>
				<Popover.Portal>
					<!-- Opening after a failed save must not steal focus from the page, and going to a problem moves focus to its field, so the popover never moves focus itself. -->
					<Popover.Content
						side="top"
						align="end"
						sideOffset={8}
						trapFocus={false}
						onOpenAutoFocus={(event) => event.preventDefault()}
						onCloseAutoFocus={(event) => event.preventDefault()}
						class="z-50 max-h-80 w-96 overflow-y-auto rounded-lg border border-line bg-white p-2 shadow-soft"
					>
						<ul aria-label="Things to fix" class="flex flex-col">
							{#each issues as issue (`${pathKey(issue.path)}:${issue.message}`)}
								<li>
									<button
										type="button"
										onclick={() => onGoToIssue(issue)}
										class="w-full rounded-md px-2 py-1.5 text-left text-xs text-ink-soft transition hover:bg-brand-tint hover:text-brand"
									>
										{issue.message}
									</button>
								</li>
							{/each}
						</ul>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		{/if}
		<Button type="submit" variant="primary" size="lg">
			{saving ? 'Saving…' : 'Save case'}
		</Button>
	</div>
</div>
