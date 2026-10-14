/**
 * Work drafts: the `drafts` row a Work's drafted writes share, what one draft says
 * about the document tree (`draft_tree_changes`). Visibility is read only through the
 * context tree view; nothing here is a live path.
 */
import type { DraftId, ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts";
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

export type DraftStatus = "active" | "closed";

export const drafts = pgTable(
  "drafts",
  {
    id: idColumn<DraftId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").$type<DraftStatus>().notNull().default("active"),
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
    // "One active draft per Work" is an application rule under the Work row lock
    // (decision 3), so this is not unique.
    index("drafts_active_origin_work")
      .on(table.originWorkId, table.createdAt)
      .where(sql`${table.status} = 'active'`),
    index("drafts_project").on(table.projectId),
    check("drafts_status_valid", sql`${table.status} IN ('active', 'closed')`),
    check(
      "drafts_closed_shape",
      sql`(${table.status} = 'closed') = (${table.closedAt} IS NOT NULL)`,
    ),
  ],
);

export type DraftTreeNodeKind = "document" | "folder";

/**
 * What one draft says about one node: that it created it. A created document's place is its
 * `documents` row; this row holds identity and attribution only. PR 3 adds deleted and base_version.
 */
export const draftTreeChanges = pgTable(
  "draft_tree_changes",
  {
    draftId: uuid("draft_id")
      .$type<DraftId>()
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    nodeKind: text("node_kind").$type<DraftTreeNodeKind>().notNull(),
    /**
     * documents.id or folders.id. No FK: nodes are never hard-deleted (tombstones),
     * and project deletion cascades through drafts.
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
    primaryKey({ columns: [table.draftId, table.nodeKind, table.nodeId] }),
    // Which drafts use a node: identity status, end of use, Discard.
    index("draft_tree_changes_node").on(table.nodeKind, table.nodeId),
    check("draft_tree_changes_node_kind_valid", sql`${table.nodeKind} IN ('document', 'folder')`),
    // Foundation rows always say "created"; PR 3 widens this with deleted.
    check("draft_tree_changes_says_something", sql`${table.created}`),
  ],
);
