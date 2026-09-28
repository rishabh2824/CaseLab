import type { ObjectType, PropertyValidators } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mutation, query } from "../_generated/server";
import { requireCurrentAdmin, requireSuperAdmin } from "../services/admins";

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

// Wraps a handler so it first runs an admin check and receives the admin on its context.
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

// Defines a query that requires a signed-in admin.
export function adminQuery<Args extends PropertyValidators, Output>(
	config: AdminHandlerConfig<QueryCtx, Args, Output>,
) {
	return query(adminHandler(requireCurrentAdmin, config));
}

// Defines a mutation that requires a signed-in admin.
export function adminMutation<Args extends PropertyValidators, Output>(
	config: AdminHandlerConfig<MutationCtx, Args, Output>,
) {
	return mutation(adminHandler(requireCurrentAdmin, config));
}

// Defines a mutation that requires a super admin.
export function superAdminMutation<Args extends PropertyValidators, Output>(
	config: AdminHandlerConfig<MutationCtx, Args, Output>,
) {
	return mutation(adminHandler(requireSuperAdmin, config));
}
