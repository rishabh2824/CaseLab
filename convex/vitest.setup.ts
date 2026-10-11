// Fails any network call a test has not stubbed, so a scheduled action can never reach a real LLM.
// Assigned directly so vi.unstubAllGlobals() restores this guard rather than the real fetch.
globalThis.fetch = async (input) => {
	const url = input instanceof Request ? input.url : String(input);
	throw new Error(`Unstubbed fetch in a Convex test: ${url}`);
};
