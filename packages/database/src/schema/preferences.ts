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
    threadGroupBy: text("thread_group_by").notNull().default("work"),
    pinnedThreadIds: text("pinned_thread_ids").array().notNull().default(sql`'{}'::text[]`),
    defaultAgentSlug: text("default_agent_slug"),
    autoResumeEnabled: boolean("auto_resume_enabled").notNull().default(true),
    autoResumeTimeoutMs: integer("auto_resume_timeout_ms").notNull().default(270_000),
    aiWriteMode: text("ai_write_mode").notNull().default("direct"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.projectId],
      name: "project_user_preferences_pk",
    }),
    check(
      "project_user_preferences_thread_group_by_check",
      sql`${table.threadGroupBy} IN ('work', 'date', 'flat')`,
    ),
    check(
      "project_user_preferences_auto_resume_timeout_check",
      sql`${table.autoResumeTimeoutMs} > 0`,
    ),
    check(
      "project_user_preferences_ai_write_mode_check",
      sql`${table.aiWriteMode} IN ('direct', 'draft')`,
    ),
  ],
);
