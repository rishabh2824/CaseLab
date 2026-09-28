import { PersistentTextStreaming } from "@convex-dev/persistent-text-streaming";
import { components } from "../_generated/api";

// The one shared client for the persistentTextStreaming component (convex.config.ts): a
// persona reply streams to the tab driving it over HTTP (http.ts's /turn-stream) while the
// component persists it at sentence boundaries for every other viewer (services/turn.ts's
// getTurnStream).
export const streaming = new PersistentTextStreaming(
	components.persistentTextStreaming,
);
