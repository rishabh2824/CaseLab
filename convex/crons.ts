import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sundays at 08:00 UTC.
crons.cron(
	"delete abandoned uploads",
	"0 8 * * 0",
	internal.files.sweepAbandonedUploads,
	{},
);

export default crons;
