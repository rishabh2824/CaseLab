import type { FieldPath } from "#shared/rules.js";

export type CaseTab = "info" | "personas";

// A string key for a path, for remembering which fields the user has touched.
export const pathKey = (path: FieldPath): string => JSON.stringify(path);

// The DOM id of the form control for a path. The only place that turns a path into an element id.
export const fieldDomId = (path: FieldPath): string =>
	`field-${path.join("-")}`;

// The tab holding a path's field: the case information tab, or the personas tab for personas and referrals.
export const tabOf = (path: FieldPath): CaseTab =>
	path[0] === "personas" || path[0] === "referrals" ? "personas" : "info";

// The persona a path belongs to, so the form can open it. A referral belongs to the persona it points at, which holds its condition field.
export function personaOf(path: FieldPath): string | undefined {
	const id =
		path[0] === "personas"
			? path[1]
			: path[0] === "referrals"
				? path[2]
				: undefined;
	return typeof id === "string" ? id : undefined;
}
