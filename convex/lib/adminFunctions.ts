import type { ObjectType, PropertyValidators } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mutation, query } from "../_generated/server";
import { requireCurrentAdmin, requireSuperAdmin } from "../services/admins";

// Convex has no middleware layer (see services/admins.ts's requireCurrentAdmin comment), so
// `await requireCurrentAdmin(ctx)` used to be the first line of every admin-gated handler,
// copy-pasted rather than enforced. adminQuery/adminMutation/superAdminMutation run the check
// themselves before the handler ever executes and hand the resolved admin doc back through
// ctx -- a handler built with one of these structurally cannot forget the check, and there's
// no `admin` in scope to use until it has already passed. Plain `query`/`mutation` from
// _generated/server stay in use for the handful of handlers (admins.viewer, which returns
// null instead of throwing) that deliberately don't gate this way.
// Shared shape for adminQuery/adminMutation/superAdminMutation below -- the three differ only
// in which Ctx they run against and which `check` function gates them, not in what a config
// object handed to any of them looks like.
type AdminHandlerConfig<
	Ctx extends QueryCtx | MutationCtx,
	Args extends PropertyValidators,
	Output,
> = {
	args: Args;
	handler: (
		ctx: Ctx & { admin: Doc<"admins"> },
		args: ObjectType<Args>,
	) => Output | Promise<Output>;
};

function adminHandler<
	Ctx extends QueryCtx | MutationCtx,
	Args extends PropertyValidators,
	Output,
>(
	check: (ctx: Ctx) => Promise<Doc<"admins">>,
	config: AdminHandlerConfig<Ctx, Args, Output>,
) {
	return {
		args: config.args,
		handler: async (ctx: Ctx, args: ObjectType<Args>) => {
			const admin = await check(ctx);
			return await config.handler({ ...ctx, admin }, args);
		},
	};
}

export function adminQuery<Args extends PropertyValidators, Output>(
	config: AdminHandlerConfig<QueryCtx, Args, Output>,
) {
	return query(adminHandler(requireCurrentAdmin, config));
}

export function adminMutation<Args extends PropertyValidators, Output>(
	config: AdminHandlerConfig<MutationCtx, Args, Output>,
) {
	return mutation(adminHandler(requireCurrentAdmin, config));
}

export function superAdminMutation<Args extends PropertyValidators, Output>(
	config: AdminHandlerConfig<MutationCtx, Args, Output>,
) {
	return mutation(adminHandler(requireSuperAdmin, config));
}
