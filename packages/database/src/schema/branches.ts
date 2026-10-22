/**
 * Work branches: the `branches` row a Work's drafted writes share, what one branch says
 * about the document tree (`branch_tree_changes`). Visibility is read only through the
 * context tree view; nothing here is a live path.
 */
import type {
  BranchId,
  ContextSourceId,
  FolderId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  pgSequence,
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
 * Every write of a row's moved or deleted facts takes the next value, so a revision never
 * recurs, even for a row deleted and made again: an Apply click freezes it.
 */
export const branchTreeChangeRevision = pgSequence("branch_tree_change_revision");

/**
 * What one branch says about one node: that it created it, moved it, or deleted it. A
 * created document's own place is its `documents` row; a moved one's place in the branch is
 * `moved_*` (its folder, or for a source's root that source, so a live move of the folder
 * carries it). The flags coexist (a move then a delete keeps the move for the delete's undo);
 * readers see one logical state, delete dominant, through the tree view.
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
    deleted: boolean("deleted").notNull().default(false),
    moved: boolean("moved").notNull().default(false),
    /** The moved document's folder in the branch. No FK, as `node_id`: folders are tombstoned. */
    movedFolderId: uuid("moved_folder_id").$type<FolderId>(),
    /** The source whose root it moved to, when it has no folder there. */
    movedRootSourceId: uuid("moved_root_source_id").$type<ContextSourceId>(),
    movedName: text("moved_name"),
    movedExtension: text("moved_extension"),
    /** `documents.location_version` when the branch first moved or deleted it. */
    baseVersion: bigint("base_version", { mode: "bigint" }),
    /**
     * From `branch_tree_change_revision` on every write of the moved or deleted facts. Null
     * only on a created row written before PR 3.
     */
    revision: bigint("revision", { mode: "bigint" }).default(
      sql`nextval('branch_tree_change_revision')`,
    ),
    /** Who made the latest move or delete. */
    changedThreadId: uuid("changed_thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    changedTurnId: uuid("changed_turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.branchId, table.nodeKind, table.nodeId] }),
    // Which branches use a node: identity status, end of use, Discard.
    index("branch_tree_changes_node").on(table.nodeKind, table.nodeId),
    // A drafted move is a use of its folder: hidden-folder liveness, pruning, normalization.
    index("branch_tree_changes_moved_folder")
      .on(table.movedFolderId)
      .where(sql`${table.movedFolderId} IS NOT NULL`),
    check("branch_tree_changes_node_kind_valid", sql`${table.nodeKind} IN ('document', 'folder')`),
    check(
      "branch_tree_changes_says_something",
      sql`${table.created} OR ${table.moved} OR ${table.deleted}`,
    ),
    // No folder moves or deletes in PR 3 (D13).
    check(
      "branch_tree_changes_tree_facts_documents",
      sql`NOT (${table.moved} OR ${table.deleted}) OR ${table.nodeKind} = 'document'`,
    ),
    check(
      "branch_tree_changes_moved_shape",
      sql`CASE WHEN ${table.moved} THEN ${table.movedName} IS NOT NULL AND ${table.movedExtension} IS NOT NULL
        AND (${table.movedFolderId} IS NULL) <> (${table.movedRootSourceId} IS NULL)
        ELSE ${table.movedFolderId} IS NULL AND ${table.movedRootSourceId} IS NULL
          AND ${table.movedName} IS NULL AND ${table.movedExtension} IS NULL END`,
    ),
    check(
      "branch_tree_changes_revision_present",
      sql`NOT (${table.moved} OR ${table.deleted}) OR ${table.revision} IS NOT NULL`,
    ),
  ],
);
