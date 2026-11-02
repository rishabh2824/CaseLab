import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sundays at 07:30 UTC: 2:30 am in Madison during daylight saving time, 1:30 am otherwise. Nobody is saving a case then.
crons.cron(
	"delete abandoned uploads",
	"30 7 * * 0",
	internal.files.sweepAbandonedUploads,
	{},
);

export default crons;
