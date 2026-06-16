/**
 * Purpose: Defines the thin local users projection keyed by an internal Meridian user id,
 * with WorkOS stored as an external credential id.
 * Why independent: Identity persistence shape is shared schema infrastructure;
 * authentication providers and authorization policies live outside this package.
 */
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    /**
     * Nullable user-level landing preference. Deliberately no FK: `projects`
     * already references `users`, and route resolution re-validates ownership
     * plus soft-delete state before trusting this soft pointer.
     */
    lastActiveProjectId: uuid("last_active_project_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("users_external_id_unique").on(table.externalId),
    unique("users_email_unique").on(table.email),
    index("users_last_active_project_idx").on(table.lastActiveProjectId),
  ],
);
