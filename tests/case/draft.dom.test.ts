import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { numberInputValue } from "../../src/lib/case/draft.js";

const inputs: HTMLInputElement[] = [];

// Puts a real number input on the page, which is what the form's number fields are.
function numberBox() {
	const input = document.createElement("input");
	input.type = "number";
	input.setAttribute("aria-label", "Amount");
	document.body.append(input);
	inputs.push(input);
	return { input, box: page.getByLabelText("Amount") };
}

afterEach(() => {
	for (const input of inputs.splice(0)) input.remove();
});

describe("numberInputValue", () => {
	// Tests that a blank field means no value.
	it("returns null for a blank field", () => {
		const { input } = numberBox();

		expect(input.validity.badInput).toBe(false);
		expect(numberInputValue(input)).toBeNull();
	});

	// Tests that text the browser could not read as a number is NaN, so validation rejects it instead of it counting as blank.
	it.each([
		["a lone minus sign", "-"],
		["an exponent with no digits", "1e"],
	])("returns NaN when %s is typed", async (_what, typed) => {
		const { input, box } = numberBox();

		await userEvent.type(box, typed);

		// The browser shows the text but reports no value: this is the case that must not look blank.
		expect(input.value).toBe("");
		expect(input.validity.badInput).toBe(true);
		expect(numberInputValue(input)).toBeNaN();
	});

	// Tests that the typed number is passed through untouched, so a decimal reaches the whole-number check.
	it.each([
		["12", 12],
		["12.9", 12.9],
		["-3.7", -3.7],
		["0", 0],
		["1e3", 1000],
	])("returns %j as %d without rounding", async (raw, expected) => {
		const { input, box } = numberBox();

		await box.fill(raw);

		expect(numberInputValue(input)).toBe(expected);
	});

	// Tests that clearing a number the user typed brings back a blank field, not the old value or NaN.
	it("returns null again after the field is cleared", async () => {
		const { input, box } = numberBox();
		await box.fill("45");
		expect(numberInputValue(input)).toBe(45);

		await box.clear();

		expect(numberInputValue(input)).toBeNull();
	});
});
