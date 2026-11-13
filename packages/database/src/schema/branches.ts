/**
 * Work branches: the `branches` row a Work's drafted writes share, what one branch says
 * about the document tree is `branch_tree_nodes` (tree-nodes.ts).
 */
import type {
  BranchId,
  ContextSourceId,
  DocumentId,
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
  integer,
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
    /** Provenance, not ownership. */
    originThreadId: uuid("origin_thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    originWorkId: uuid("origin_work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "set null" }),
    /**
     * The other owner: the conversation lineage (a chat with no Work, its forks and
     * subagents) owning this branch directly. No FK, as `context_sources.root_thread_id`:
     * trashing or purging the first chat must not cascade into the drafts.
     */
    originRootThreadId: uuid("origin_root_thread_id").$type<ThreadId>(),
    /** The branch's pending documents; recounted at commit for every branch a write set locked. */
    pendingDocumentCount: integer("pending_document_count").notNull().default(0),
    createdBy: uuid("created_by")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    // "One active branch per Work" is an application rule under the Work row lock,
    // so this is not unique.
    index("branches_active_origin_work")
      .on(table.originWorkId, table.createdAt)
      .where(sql`${table.status} = 'active'`),
    index("branches_active_origin_lineage")
      .on(table.projectId, table.originRootThreadId, table.createdAt)
      .where(sql`${table.status} = 'active' AND ${table.originRootThreadId} IS NOT NULL`),
    index("branches_project").on(table.projectId),
    // A closed branch may have no owner (a hard Work purge nulls its Work); an active one has one.
    check(
      "branches_one_owner",
      sql`num_nonnulls(${table.originWorkId}, ${table.originRootThreadId}) <= 1 AND (${table.status} = 'closed' OR num_nonnulls(${table.originWorkId}, ${table.originRootThreadId}) = 1)`,
    ),
    check("branches_status_valid", sql`${table.status} IN ('active', 'closed')`),
    check(
      "branches_closed_shape",
      sql`(${table.status} = 'closed') = (${table.closedAt} IS NOT NULL)`,
    ),
  ],
);

export type BranchTreeNodeKind = "document" | "folder";
export type BranchTreeParentKind = "source" | "folder";
