import type { ProjectId, UserId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth";
import { projects } from "./content";

export const workbenchUserPreferences = pgTable(
  "workbench_user_preferences",
  {
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    workbenchId: uuid("workbench_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadGroupBy: text("thread_group_by").notNull().default("work"),
    pinnedThreadIds: text("pinned_thread_ids").array().notNull().default(sql`'{}'::text[]`),
    defaultAgentSlug: text("default_agent_slug"),
    autoResumeEnabled: boolean("auto_resume_enabled").notNull().default(true),
    autoResumeTimeoutMs: integer("auto_resume_timeout_ms").notNull().default(270_000),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.workbenchId],
      name: "workbench_user_preferences_pk",
    }),
    check(
      "workbench_user_preferences_thread_group_by_check",
      sql`${table.threadGroupBy} IN ('work', 'date', 'flat')`,
    ),
    check(
      "workbench_user_preferences_auto_resume_timeout_check",
      sql`${table.autoResumeTimeoutMs} > 0`,
    ),
  ],
);
