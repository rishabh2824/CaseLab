// Returns up to two upper-case initials from a persona's name, or 'NA' when there is none.
export const getPersonaInitials = (name: string | undefined | null) =>
	name
		? name
				.split(" ")
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => Array.from(part)[0]?.toUpperCase() ?? "")
				.join("")
		: "NA";
