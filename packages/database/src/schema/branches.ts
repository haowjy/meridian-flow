/**
 * Work branches: the `branches` row a Work's drafted writes share, what one branch says
 * about the document tree (`branch_tree_changes`). Visibility is read only through the
 * context tree view; nothing here is a live path.
 */
import type { BranchId, ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "./_shared";
import { threads, turns } from "./agent-threads";
import { projects, works } from "./content";
import { users } from "./users";

export type BranchStatus = "active" | "closed";

export const branches = pgTable(
  "branches",
  {
    id: idColumn<BranchId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").$type<BranchStatus>().notNull().default("active"),
    /** Provenance, not ownership (decision 3). */
    originThreadId: uuid("origin_thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    originWorkId: uuid("origin_work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    // "One active branch per Work" is an application rule under the Work row lock
    // (decision 3), so this is not unique.
    index("branches_active_origin_work")
      .on(table.originWorkId, table.createdAt)
      .where(sql`${table.status} = 'active'`),
    index("branches_project").on(table.projectId),
    check("branches_status_valid", sql`${table.status} IN ('active', 'closed')`),
    check(
      "branches_closed_shape",
      sql`(${table.status} = 'closed') = (${table.closedAt} IS NOT NULL)`,
    ),
  ],
);

export type BranchTreeNodeKind = "document" | "folder";

/**
 * What one branch says about one node: that it created it. A created document's place is its
 * `documents` row; this row holds identity and attribution only. PR 3 adds deleted and base_version.
 */
export const branchTreeChanges = pgTable(
  "branch_tree_changes",
  {
    branchId: uuid("branch_id")
      .$type<BranchId>()
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    nodeKind: text("node_kind").$type<BranchTreeNodeKind>().notNull(),
    /**
     * documents.id or folders.id. No FK: nodes are never hard-deleted (tombstones),
     * and project deletion cascades through branches.
     */
    nodeId: uuid("node_id").notNull(),
    created: boolean("created").notNull().default(false),
    /** Who created the node: null for a writer's create and for rows before attribution. */
    createdThreadId: uuid("created_thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    createdTurnId: uuid("created_turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.branchId, table.nodeKind, table.nodeId] }),
    // Which branches use a node: identity status, end of use, Discard.
    index("branch_tree_changes_node").on(table.nodeKind, table.nodeId),
    check("branch_tree_changes_node_kind_valid", sql`${table.nodeKind} IN ('document', 'folder')`),
    // Foundation rows always say "created"; PR 3 widens this with deleted.
    check("branch_tree_changes_says_something", sql`${table.created}`),
  ],
);
