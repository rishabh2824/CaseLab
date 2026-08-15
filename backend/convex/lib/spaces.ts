import { AwsClient } from "aws4fetch";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

function getClient(): AwsClient {
	return new AwsClient({
		accessKeyId: requireEnv("SPACES_KEY"),
		secretAccessKey: requireEnv("SPACES_SECRET"),
		region: requireEnv("SPACES_REGION"),
		service: "s3",
	});
}

// DigitalOcean Spaces' virtual-hosted-style URL (https://{bucket}.{region}.digitaloceanspaces.com/{key}) --
// the same addressing boto3 resolves to for backend/infra/spaces.py's endpoint_url + Bucket param.
function objectUrl(objectKey: string): string {
	const host = new URL(requireEnv("SPACES_ENDPOINT")).host;
	const bucket = requireEnv("SPACES_BUCKET");
	const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
	return `https://${bucket}.${host}/${encodedKey}`;
}

// Mirrors backend/infra/spaces.py's putUrl: a presigned PUT URL, signed with the same
// Content-Type the caller will upload with (if any) -- the client must send an identical
// header on the actual PUT or the signature won't validate, the same constraint boto3's
// generate_presigned_url(Params={"ContentType": ...}) imposes.
export async function presignPutUrl(
	objectKey: string,
	contentType: string | undefined,
	expiresInSeconds: number,
): Promise<string> {
	const headers: Record<string, string> = {};
	if (contentType) headers["content-type"] = contentType;
	// aws4fetch has no `expires` option -- it only defaults X-Amz-Expires to 86400 when the
	// signed URL doesn't already carry one, so the desired expiry has to be set on the URL
	// itself before signing.
	const url = new URL(objectUrl(objectKey));
	url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
	const signed = await getClient().sign(url, {
		method: "PUT",
		headers,
		aws: { signQuery: true },
	});
	return signed.url;
}

// Mirrors backend/infra/spaces.py's getUrl, minus its 15-minute-bucket lru_cache -- that
// cache existed only so repeat reads of the same object within a window got the
// byte-identical (browser-cacheable) URL back. Callers here (http.ts's /files/:objectKey
// route) already hand out a URL that never changes -- the case doc's objectKey -- and sign
// fresh only at the moment a request actually arrives, so there's nothing to cache.
export async function presignGetUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
	const url = new URL(objectUrl(objectKey));
	url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
	const signed = await getClient().sign(url, {
		method: "GET",
		aws: { signQuery: true },
	});
	return signed.url;
}

// Mirrors backend/infra/spaces.py's deleteObject.
export async function deleteObject(objectKey: string): Promise<void> {
	const response = await getClient().fetch(objectUrl(objectKey), { method: "DELETE" });
	// S3-compatible DELETE returns 204 whether or not the key already existed -- only a
	// non-404 failure indicates a real problem (bad credentials, wrong bucket, etc).
	if (!response.ok && response.status !== 404) {
		throw new Error(`Failed to delete Spaces object "${objectKey}" (HTTP ${response.status}).`);
	}
}
