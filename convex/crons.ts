import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Backstop for startSimulation's per-run destroy scheduling (services/simulations.ts) --
// see deleteExpiredRuns's own comment for why this should normally find nothing to do. Runs
// at a coarse interval since it's a backstop rather than the primary cleanup path.
crons.interval(
	"reconcile expired simulation runs",
	{ hours: 24 * 7 },
	internal.api.simulations.deleteExpiredRuns,
	{},
);

// Backstop for api/uploads.ts's discardUploads -- see sweepOrphanedStorage's own comment
// (api/files.ts) for what this catches that the primary path can't.
crons.interval(
	"sweep orphaned storage uploads",
	{ hours: 24 * 7 },
	internal.api.files.sweepOrphanedStorage,
	{},
);

export default crons;
