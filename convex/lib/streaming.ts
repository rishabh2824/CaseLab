import { PersistentTextStreaming } from "@convex-dev/persistent-text-streaming";
import { components } from "../_generated/api";

export const streaming = new PersistentTextStreaming(
	components.persistentTextStreaming,
);
