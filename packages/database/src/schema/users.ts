/**
 * Purpose: Defines the thin local users projection keyed by an internal Meridian user id,
 * with WorkOS stored as an external credential id.
 * Why independent: Identity persistence shape is shared schema infrastructure;
 * authentication providers and authorization policies live outside this package.
 */
import type { DocumentId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The id of this account's tree list (`user://`), its own and never a node's id. */
    treeListId: uuid("tree_list_id")
      .$type<DocumentId>()
      .notNull()
      .unique()
      .default(sql`gen_random_uuid()`),
    externalId: text("external_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    stripeCustomerId: text("stripe_customer_id"),
    workingSetSyncEnabled: boolean("working_set_sync_enabled").notNull().default(true),
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
  ],
);
