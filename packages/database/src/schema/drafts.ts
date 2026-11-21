/**
 * Drafts: everything pending in one draft, its suggestion marks in Live documents and its tree
 * records (`draft_tree_nodes`, tree-nodes.ts). A draft names no owner: a Work names its draft
 * (`works.draft_id`) and a root conversation names its lineage's (`threads.draft_id`), each minted
 * with the row that names it.
 */
import type { DraftId, ProjectId, UserId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./_shared";
import { projects } from "./content";
import { users } from "./users";

export const drafts = pgTable(
  "drafts",
  {
    /** 12 base-36 characters (`newDraftId`): it sits on every suggestion mark in Live history. */
    id: text("id").$type<DraftId>().primaryKey(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The draft's pending documents; recounted at commit for every draft a write set locked. */
    pendingDocumentCount: integer("pending_document_count").notNull().default(0),
    pendingFolderCount: integer("pending_folder_count").notNull().default(0),
    createdBy: uuid("created_by")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("drafts_project").on(table.projectId),
    check("drafts_id_shape", sql`${table.id} ~ '^[0-9a-z]{12}$'`),
  ],
);

/** A draft id column referencing `drafts`. */
export const draftIdColumn = (name: string) =>
  text(name)
    .$type<DraftId>()
    .references(() => drafts.id, { onDelete: "cascade" });

export type DraftTreeNodeKind = "document" | "folder";
export type DraftTreeParentKind = "source" | "folder";
