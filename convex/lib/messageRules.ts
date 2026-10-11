// Counts whitespace-separated words. Shared by the server's message limit and the student page's live counter, so they cannot disagree.
export const countWords = (value: string): number =>
	value.trim().split(/\s+/).filter(Boolean).length;
