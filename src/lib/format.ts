export const countWords = (value: unknown) =>
	String(value ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;
