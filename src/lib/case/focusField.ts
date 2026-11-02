import { tick } from "svelte";
import type { FieldPath } from "#shared/rules.js";
import { fieldDomId } from "./fieldPath.js";

// Scrolls to a form field and focuses it, first opening any collapsed sections around it.
export async function focusField(path: FieldPath): Promise<void> {
	await tick();
	const field = document.getElementById(fieldDomId(path));
	if (!field) return;
	for (
		let section = field.closest("details");
		section;
		section = section.parentElement?.closest("details") ?? null
	) {
		section.open = true;
	}
	field.scrollIntoView({ block: "center" });
	field.focus({ preventScroll: true });
}
