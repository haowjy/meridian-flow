import type { DocumentId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
