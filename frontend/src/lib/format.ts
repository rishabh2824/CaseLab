// Generic string-formatting utilities, shared across the case and student domains.

// Lowercase, replace runs of non-alphanumerics with a single '-', trim '-'.
export const slugify = (value: unknown) =>
	String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

export const countWords = (value: unknown) =>
	String(value ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;
