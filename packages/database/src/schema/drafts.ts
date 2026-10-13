/**
 * Work drafts: the `drafts` row a Work's drafted writes share, what one draft says
 * about the document tree (`draft_tree_changes`), and what an ahead ref means in one
 * draft's view (`link_ahead_draft_settlements`). Visibility is read only through the
 * context tree view; nothing here is a live path.
 */
import type {
  ContextSourceId,
  DocumentId,
  DraftId,
  FolderId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts";
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
import { contextSources, documents, folders, linkAheadRefs, projects, works } from "./content";
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

/** What one draft says about one node. PR 3 adds deleted and base_version. */
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
    /** The draft's location for the node; all null when the draft sets none. */
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    parentFolderId: uuid("parent_folder_id")
      .$type<FolderId>()
      .references(() => folders.id, { onDelete: "cascade" }),
    name: text("name"),
    extension: text("extension"),
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
    // How a create finds a hidden document another draft placed at a path.
    index("draft_tree_changes_location")
      .on(table.contextSourceId, table.parentFolderId, table.name, table.extension)
      .where(sql`${table.contextSourceId} IS NOT NULL`),
    // Which drafts use a node: identity status, end of use, Discard.
    index("draft_tree_changes_node").on(table.nodeKind, table.nodeId),
    // Absorb and split repoint rows by parent.
    index("draft_tree_changes_parent")
      .on(table.parentFolderId)
      .where(sql`${table.parentFolderId} IS NOT NULL`),
    check("draft_tree_changes_node_kind_valid", sql`${table.nodeKind} IN ('document', 'folder')`),
    check(
      "draft_tree_changes_location_shape",
      sql`(${table.contextSourceId} IS NULL AND ${table.parentFolderId} IS NULL AND ${table.name} IS NULL
        AND ${table.extension} IS NULL)
      OR (${table.contextSourceId} IS NOT NULL AND ${table.name} IS NOT NULL
        AND (${table.nodeKind} = 'document') = (${table.extension} IS NOT NULL))`,
    ),
    // Foundation rows always say "created"; PR 3 widens this with deleted.
    check(
      "draft_tree_changes_says_something",
      sql`${table.created} OR ${table.contextSourceId} IS NOT NULL`,
    ),
  ],
);

/** What an ahead ref means in one draft's view; read only in that view. */
export const linkAheadDraftSettlements = pgTable(
  "link_ahead_draft_settlements",
  {
    aheadId: uuid("ahead_id")
      .notNull()
      .references(() => linkAheadRefs.aheadId, { onDelete: "cascade" }),
    draftId: uuid("draft_id")
      .$type<DraftId>()
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    // CASCADE only fires on project deletion: no product path hard-deletes a document.
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.aheadId, table.draftId] }),
    index("link_ahead_draft_settlements_draft").on(table.draftId),
    index("link_ahead_draft_settlements_document").on(table.documentId),
  ],
);
