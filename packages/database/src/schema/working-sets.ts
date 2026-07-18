/** Per-user project working-set snapshots used to resume writing across devices. */
import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { threads } from "./agent-threads";
import { projects } from "./content";
import { users } from "./users";

export const projectUserWorkingSets = pgTable(
  "project_user_working_sets",
  {
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Most-recent-first, capped at 3. [0] is the last-active document.
    // [] means the desk was cleared. Entry shape: WorkingSetRoute.
    recentRoutes: jsonb("recent_routes")
      .$type<WorkingSetRoute[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastThreadId: uuid("last_thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    // The sync generation: incremented atomically on every upsert
    // (insert 1; conflict → revision + 1 in the SET clause). The client
    // stores the returned value and compares it at hydration. Nothing but
    // this domain ever writes the row — that exclusivity is load-bearing.
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.projectId],
      name: "project_user_working_sets_pk",
    }),
  ],
);
