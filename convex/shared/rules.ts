// Case and message limits, and the field rules built on them. Shared by the Convex backend (which throws the first failing rule) and the browser (which shows them inline). Kept free of Convex imports.

export const MAX_DURATION_MINUTES = 120;

export const MAX_MESSAGE_WORDS = 50;

export const ACCESS_CODE_FORMAT = /^[a-z]+$/;

// Trims and lower-cases an access code, so every place that stores, compares or looks one up agrees on its form.
export const normalizeAccessCode = (value: string): string =>
	value.trim().toLowerCase();

export const ACCESS_CODE_CONFLICT =
	"This access code is already used by another case. Choose a different one.";

// Where a field lives in a case, mirroring the saved payload: ["name"], ["personas", id, "role"], ["personas", id, "files", 0, "file"], ["referrals", fromId, toId, "conditions"]. The form decides how to find the field from this.
export type FieldPath = (string | number)[];

// One thing stopping a case from saving, and the field to fix.
export type CaseIssue = {
	path: FieldPath;
	message: string;
};

type CaseForIssues = {
	name: string;
	brief: string;
	accessCode: string;
	duration: number | null;
	personas: {
		id: string;
		name: string;
		role: string;
		knownFacts: string;
		availabilityMinutes?: number | null;
		responseDelaySeconds?: number | null;
		files: { file?: unknown; shareConditions: string }[];
	}[];
	referrals: { fromId: string; toId: string; conditions: string }[];
};

// The list of personas as a whole, where "add at least one persona" points.
export const PERSONAS_PATH: FieldPath = ["personas"];

// A case-level field.
export const casePath = (
	field: "name" | "brief" | "accessCode" | "duration",
): FieldPath => [field];

// A field in a persona's editor.
export const personaPath = (
	personaId: string,
	field:
		| "name"
		| "role"
		| "profilePhoto"
		| "knownFacts"
		| "personalityTraits"
		| "availabilityMinutes"
		| "responseDelaySeconds",
): FieldPath => ["personas", personaId, field];

// A field in one of a persona's file rows.
export const filePath = (
	personaId: string,
	fileIndex: number,
	field: "file" | "shareConditions" | "perceivedContents",
): FieldPath => ["personas", personaId, "files", fileIndex, field];

// A referral's condition field.
export const referralPath = (fromId: string, toId: string): FieldPath => [
	"referrals",
	fromId,
	toId,
	"conditions",
];

// Lists everything that must be fixed before the case can save, in the order the form shows it. Shared by the form and the server, so they cannot disagree. Every referral needs a condition because a blank one is never offered to the model: with starting personas always open and cycles rejected, that is what guarantees each persona can be reached.
export function getCaseIssues({
	name,
	brief,
	accessCode,
	duration,
	personas,
	referrals,
}: CaseForIssues): CaseIssue[] {
	const issues: CaseIssue[] = [];

	if (!name.trim()) {
		issues.push({
			path: casePath("name"),
			message: "Case name is required.",
		});
	}
	if (!brief.trim()) {
		issues.push({
			path: casePath("brief"),
			message: "Student brief is required.",
		});
	}

	const code = normalizeAccessCode(accessCode);
	if (!code) {
		issues.push({
			path: casePath("accessCode"),
			message: "Access code is required.",
		});
	} else if (!ACCESS_CODE_FORMAT.test(code)) {
		issues.push({
			path: casePath("accessCode"),
			message:
				"Access code can only contain letters, with no spaces or numbers.",
		});
	}

	if (
		typeof duration === "number" &&
		(!Number.isInteger(duration) ||
			duration < 1 ||
			duration > MAX_DURATION_MINUTES)
	) {
		const hours = MAX_DURATION_MINUTES / 60;
		const hoursLabel = Number.isInteger(hours)
			? String(hours)
			: hours.toFixed(1);
		issues.push({
			path: casePath("duration"),
			message:
				`Time limit must be a whole number of minutes between 1 and ${MAX_DURATION_MINUTES} ` +
				`(${hoursLabel} hour${hours === 1 ? "" : "s"}).`,
		});
	}

	if (personas.length === 0) {
		issues.push({
			path: PERSONAS_PATH,
			message: "Add at least one persona.",
		});
	}

	const labels = new Map(
		personas.map((persona, index) => [
			persona.id,
			persona.name.trim() || `Persona ${index + 1}`,
		]),
	);
	const labelOf = (personaId: string): string =>
		labels.get(personaId) ?? "Unknown persona";

	for (const persona of personas) {
		const label = labelOf(persona.id);
		const add = (path: FieldPath, message: string) =>
			issues.push({ path, message });

		if (!persona.name.trim()) {
			add(personaPath(persona.id, "name"), `${label}: add a name.`);
		}
		if (!persona.role.trim()) {
			add(personaPath(persona.id, "role"), `${label}: add a title or role.`);
		}
		if (!persona.knownFacts.trim()) {
			add(
				personaPath(persona.id, "knownFacts"),
				`Add what ${label} knows. Personas can only answer from these facts.`,
			);
		}
		if (
			typeof persona.availabilityMinutes === "number" &&
			(!Number.isInteger(persona.availabilityMinutes) ||
				persona.availabilityMinutes < 1)
		) {
			add(
				personaPath(persona.id, "availabilityMinutes"),
				`${label}: availability must be a whole number of minutes, at least 1.`,
			);
		}
		if (
			typeof persona.responseDelaySeconds === "number" &&
			(!Number.isInteger(persona.responseDelaySeconds) ||
				persona.responseDelaySeconds < 1)
		) {
			add(
				personaPath(persona.id, "responseDelaySeconds"),
				`${label}: response delay must be a whole number of seconds, at least 1.`,
			);
		}

		// The condition field sits on the referred persona, so that is the persona a missing one counts against.
		for (const { fromId, toId, conditions } of referrals) {
			if (toId === persona.id && !conditions.trim()) {
				add(
					referralPath(fromId, toId),
					`Add when ${labelOf(fromId)} should refer the student to ${label}. Until then, students can't reach ${label}.`,
				);
			}
		}

		for (const [index, entry] of persona.files.entries()) {
			const fileLabel = `${label}, File ${index + 1}`;
			if (!entry.file) {
				add(
					filePath(persona.id, index, "file"),
					`${fileLabel}: upload the file or remove this row.`,
				);
			}
			if (!entry.shareConditions.trim()) {
				add(
					filePath(persona.id, index, "shareConditions"),
					`${fileLabel}: add when ${label} should share this file.`,
				);
			}
		}
	}

	return issues;
}

// Returns whether an admin may be chosen as a collaborator: anyone but the effective owner. Super admins are allowed so they can be credited as authors. Only the picker uses this; the server's save-time check rejects the owner on its own.
export const isSelectableCollaborator = (
	admin: { _id: string },
	effectiveOwnerId: string | null,
): boolean => admin._id !== effectiveOwnerId;

// Counts whitespace-separated words. Shared by the server's message limit and the student page's live counter, so they cannot disagree.
export const countWords = (value: string): number =>
	value.trim().split(/\s+/).filter(Boolean).length;
