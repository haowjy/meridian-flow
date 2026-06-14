import type { UserId } from "@meridian/contracts";
import { pgSchema, uuid } from "drizzle-orm/pg-core";

/**
 * Supabase-managed `auth.users` — stub for FK typing only.
 * Never included in Drizzle migrations (see drizzle.config schemaFilter).
 */
export const authSchema = pgSchema("auth");

export const authUsers = authSchema.table("users", {
  id: uuid("id").$type<UserId>().primaryKey(),
});
