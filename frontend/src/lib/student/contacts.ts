// Data-shaping helpers for the student chat view

export const getPersonaInitials = (name: string | undefined | null) =>
	name
		? name
				.split(" ")
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0]?.toUpperCase() ?? "")
				.join("")
		: "NA";
