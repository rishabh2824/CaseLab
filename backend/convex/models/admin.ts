import { v } from "convex/values";

// Mirrors backend/models/admin.py's AdminRole IntEnum (SUPER=1, ADMIN=2), spelled
// out as string literals here since Convex has no enum type and this is read at
// every authorization check. Shared by schema.ts (storage shape) and
// services/admins.ts (anywhere the role is checked/returned).
export const adminRole = v.union(v.literal("super"), v.literal("admin"));
export type AdminRole = "super" | "admin";
