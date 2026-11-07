import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import type { Id } from "#convex/dataModel.js";
import PersonaFields from "../../../src/lib/components/case/PersonaFields.svelte";
import type { Persona } from "../../../src/lib/types.js";
import { makePersona } from "../../support/factories.js";

// Renders the fields for a reactive persona and returns it, so tests can read what the inputs wrote.
async function renderFields(
	overrides: Partial<Persona> = {},
): Promise<Persona> {
	const persona = $state(makePersona(overrides));
	await render(PersonaFields, { persona, errorFor: () => undefined });
	return persona;
}

describe("response delay", () => {
	// Tests that typing a delay stores it as a number of seconds, and clearing it means no delay.
	it("stores the typed delay in seconds and clears it back to no delay", async () => {
		const persona = await renderFields();
		const input = page.getByLabelText("Response delay (seconds)");
		await expect.element(input).toHaveValue(null);
		await expect.element(input).toHaveAttribute("placeholder", "No delay");

		await input.fill("45");
		expect(persona.responseDelaySeconds).toBe(45);

		await input.clear();
		expect(persona.responseDelaySeconds).toBeNull();
	});

	// Tests that a saved delay shows in the box.
	it("shows a saved delay", async () => {
		await renderFields({ responseDelaySeconds: 30 });
		await expect
			.element(page.getByLabelText("Response delay (seconds)"))
			.toHaveValue(30);
	});
});

describe("profile photo", () => {
	// Tests that choosing a photo stores the file on the persona and names it under the input.
	it("stores a chosen photo and names it", async () => {
		const persona = await renderFields();
		const photo = new File(["png"], "mary.png", { type: "image/png" });

		await page.getByLabelText("Profile photo").upload(photo);

		// The browser hands over its own copy of the chosen file, so compare what it holds.
		expect(persona.profilePhoto).toBeInstanceOf(File);
		expect(persona.profilePhoto).toMatchObject({
			name: "mary.png",
			type: "image/png",
		});
		await expect.element(page.getByText("Selected: mary.png")).toBeVisible();
	});

	// Tests that a photo saved earlier is named as the existing photo, and that choosing a new one replaces it.
	it("names a saved photo, and replaces it when a new one is chosen", async () => {
		const persona = await renderFields({
			profilePhoto: {
				storageId: "storage-1" as Id<"_storage">,
				fileName: "old.png",
				contentType: "image/png",
			},
		});
		await expect
			.element(page.getByText("Existing photo: old.png"))
			.toBeVisible();

		const photo = new File(["png"], "new.png", { type: "image/png" });
		await page.getByLabelText("Profile photo").upload(photo);

		expect(persona.profilePhoto).toBeInstanceOf(File);
		expect(persona.profilePhoto).toMatchObject({ name: "new.png" });
		await expect.element(page.getByText("Selected: new.png")).toBeVisible();
		await expect
			.element(page.getByText("Existing photo: old.png"))
			.not.toBeInTheDocument();
		// The input is reset, so choosing the same file again still registers.
		await expect.element(page.getByLabelText("Profile photo")).toHaveValue("");
	});

	// Tests that a persona with no photo names nothing under the input.
	it("names nothing when there is no photo", async () => {
		await renderFields();
		await expect.element(page.getByText(/^Selected:/)).not.toBeInTheDocument();
		await expect
			.element(page.getByText(/^Existing photo:/))
			.not.toBeInTheDocument();
	});
});
