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
