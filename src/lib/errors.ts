import { appErrorData } from "#shared/errors.js";

// An error raised in the browser whose message is written for the user, like the ones the server throws.
export class UserError extends Error {}

// Returns the message of an error written for the user (a server { code, message } error or a UserError), or the fallback for anything else, such as a redacted server error or a network failure.
export function getErrorMessage(err: unknown, fallback: string): string {
	if (err instanceof UserError) return err.message;
	return appErrorData(err)?.message ?? fallback;
}
