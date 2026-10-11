import type { ProjectId, UserId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "./content";
import { users } from "./users";

export const projectUserPreferences = pgTable(
  "project_user_preferences",
  {
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    autoResumeEnabled: boolean("auto_resume_enabled").notNull().default(true),
    autoResumeTimeoutMs: integer("auto_resume_timeout_ms").notNull().default(270_000),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.projectId],
      name: "project_user_preferences_pk",
    }),
    check(
      "project_user_preferences_auto_resume_timeout_check",
      sql`${table.autoResumeTimeoutMs} > 0`,
    ),
  ],
);
