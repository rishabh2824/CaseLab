import { describe, expect, it } from "vitest";
import { getCaseInfoErrors, getPersonaFieldErrors } from "./caseRules";
import { RUN_LIFETIME_MINUTES } from "./constants";

const valid = {
	caseName: "Sterling",
	initialBrief: "Cut costs.",
	accessCode: "sterling",
	simulationDurationMinutes: 30,
};

describe("getCaseInfoErrors", () => {
	// Tests that a valid case has no errors, with or without a duration.
	it("accepts a valid case, with or without a duration", () => {
		expect(getCaseInfoErrors(valid)).toEqual({});
		expect(
			getCaseInfoErrors({ ...valid, simulationDurationMinutes: null }),
		).toEqual({});
	});

	// Tests that blank required fields are reported with their messages, in field order.
	it("reports blank required fields in field order", () => {
		const errors = getCaseInfoErrors({
			caseName: "  ",
			initialBrief: "",
			accessCode: " ",
			simulationDurationMinutes: null,
		});
		expect(Object.entries(errors)).toEqual([
			["caseName", "Case name is required."],
			["initialBrief", "Initial brief is required."],
			["accessCode", "Access code is required."],
		]);
	});

	// Tests that an access code must be lowercase letters only.
	it.each(["Sterling", "case1", "two words", "case-one"])(
		"rejects the access code %s",
		(accessCode) => {
			expect(getCaseInfoErrors({ ...valid, accessCode }).accessCode).toBe(
				"Access code must contain only lowercase letters.",
			);
		},
	);

	// Tests that the duration must be a whole number within the run lifetime.
	it.each([0, -5, 2.5, RUN_LIFETIME_MINUTES + 1])(
		"rejects a duration of %s minutes",
		(simulationDurationMinutes) => {
			expect(
				getCaseInfoErrors({ ...valid, simulationDurationMinutes })
					.simulationDuration,
			).toContain("whole number of minutes between 1 and 120");
		},
	);

	// Tests that the boundary durations are accepted.
	it.each([1, RUN_LIFETIME_MINUTES])(
		"accepts a duration of %s minutes",
		(n) => {
			expect(
				getCaseInfoErrors({ ...valid, simulationDurationMinutes: n })
					.simulationDuration,
			).toBeUndefined();
		},
	);
});

describe("getPersonaFieldErrors", () => {
	const persona = { name: "Mary", role: "CFO", availabilityMinutes: null };

	// Tests that a valid persona has no errors.
	it("accepts a valid persona, with or without an availability", () => {
		expect(getPersonaFieldErrors(persona)).toEqual({});
		expect(
			getPersonaFieldErrors({ ...persona, availabilityMinutes: 30 }),
		).toEqual({});
	});

	// Tests that a blank name or role is reported.
	it("reports a blank name and role", () => {
		expect(getPersonaFieldErrors({ ...persona, name: " ", role: "" })).toEqual({
			name: "Name is required.",
			role: "Role is required.",
		});
	});

	// Tests that the availability must be a whole number of at least one minute.
	it.each([0, -1, 1.5])("rejects an availability of %s minutes", (n) => {
		expect(
			getPersonaFieldErrors({ ...persona, availabilityMinutes: n })
				.availability,
		).toBeTruthy();
	});
});
