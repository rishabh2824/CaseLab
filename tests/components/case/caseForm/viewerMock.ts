import type { FunctionReturnType } from "convex/server";
import type { api } from "#convex/api.js";

// The signed-in admin the mocked `#lib/adminViewer.js` reports. It lives in a module of its own because the mock factory imports it while the form is still loading, and a factory that imported the larger support module (which imports the form) would wait on itself.
export const viewerState: {
	current: FunctionReturnType<typeof api.admins.viewer>;
} = { current: null };

// Each test file mocks the viewer with `vi.mock("#lib/adminViewer.js", async () => (await import("./viewerMock.js")).adminViewerModule)`.
export const adminViewerModule = {
	getViewerContext: () => ({
		data: viewerState.current,
		error: undefined,
		isLoading: false,
		isStale: false,
	}),
};
