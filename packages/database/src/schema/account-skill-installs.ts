/** Account-owned skill installs: availability that can grow without changing a bound Agent. */
import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./_shared";
import { users } from "./users";

export const accountSkillInstalls = pgTable(
  "account_skill_installs",
  {
    id: idColumn(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("account_skill_installs_owner_slug").on(table.ownerUserId, table.slug)],
);
