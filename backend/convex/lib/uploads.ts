// Mirrors backend/services/uploads.py's buildObjectKey. Path-traversal-safe: drops any "",
// "." or ".." segment so a caller-supplied prefix can never escape the bucket's intended
// folder.
export function buildObjectKey(fileName: string, prefix: string | undefined): string {
	const dotIndex = fileName.lastIndexOf(".");
	const extension = dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
	const safePrefix = (prefix ? prefix.split("/") : [])
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
		.join("/");
	const keyBase = `${crypto.randomUUID().replace(/-/g, "")}${extension}`;
	return safePrefix ? `${safePrefix}/${keyBase}` : keyBase;
}
