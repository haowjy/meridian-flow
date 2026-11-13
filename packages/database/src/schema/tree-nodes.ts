import type { BranchId, ContextSourceId, DocumentId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { branches } from "./branches";
import { contextSources } from "./content";
import { documentYjsHeads } from "./yjs";

type NodeKind = "folder" | "document";

/**
 * The claim on a node id: one row per id any list has made a node of, never deleted while the
 * list lives, so an id is never made twice and no two lists hold it. The unique key is the
 * claim: the admitting transaction inserts the row, and a conflict means the id is taken. The
 * rows of a node reference its claim with its list, so a row can never be written for another
 * list's id, and an upsert cannot move one.
 */
export const treeNodeIds = pgTable(
  "tree_node_ids",
  {
    id: uuid("id").$type<DocumentId>().primaryKey(),
    listId: uuid("list_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documentYjsHeads.documentId, { onDelete: "cascade" }),
  },
  (table) => [unique("tree_node_ids_id_list").on(table.id, table.listId)],
);

/**
 * The live tree: one row per folder and document that is in live or in live's Trash, written
 * only by the replay of the project's list (`domains/context`, tree store), in the transaction
 * that admits the records. A node's id is a folder's id or a `documents.id`.
 */
export const treeNodes = pgTable(
  "tree_nodes",
  {
    id: uuid("id").$type<DocumentId>().primaryKey(),
    /** The tree list (a project's, or an account's) whose replay wrote this row. */
    listId: uuid("list_id").$type<DocumentId>().notNull(),
    kind: text("kind").$type<NodeKind>().notNull(),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    /** Null for the top of a source. */
    parentId: uuid("parent_id").$type<DocumentId>(),
    /** The name shown, numbered where a sibling shows the same, with its extension. */
    name: text("name").notNull(),
    /** What follows the last dot of the name, lowercased; empty for a folder. */
    extension: text("extension").notNull().default(""),
    /** The name without its extension: the link-name lookup's key, which an index can serve. */
    stem: text("stem").generatedAlwaysAs(
      sql`CASE WHEN extension <> '' THEN left(name, -(length(extension) + 1)) ELSE name END`,
    ),
    /** A document's type: the editor that opens it. Null for a folder. */
    fileType: text("file_type"),
    rank: text("rank").notNull(),
    /** Text derivations compare it: bumped when the node's path changes. */
    locationVersion: bigint("location_version", { mode: "bigint" }).notNull().default(sql`0`),
    /** The `delete` record that put the node in Trash, and when the server admitted it. */
    trashRecord: text("trash_record"),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
  },
  (table) => [
    // The target of the composite foreign key below.
    unique("tree_nodes_id_source").on(table.id, table.contextSourceId),
    foreignKey({
      name: "tree_nodes_claimed_by_list",
      columns: [table.id, table.listId],
      foreignColumns: [treeNodeIds.id, treeNodeIds.listId],
    }).onDelete("cascade"),
    foreignKey({
      name: "tree_nodes_parent_in_source",
      columns: [table.parentId, table.contextSourceId],
      foreignColumns: [table.id, table.contextSourceId],
    }),
    check("tree_nodes_kind_valid", sql`${table.kind} IN ('folder', 'document')`),
    check(
      "tree_nodes_file_type_of_document",
      sql`(${table.kind} = 'folder') = (${table.fileType} IS NULL)`,
    ),
    check("tree_nodes_rank_present", sql`${table.rank} <> ''`),
    check(
      "tree_nodes_trash_shape",
      sql`(${table.trashRecord} IS NULL) = (${table.trashedAt} IS NULL)`,
    ),
    index("tree_nodes_walk").on(table.contextSourceId, table.parentId, table.name),
    // The link-name lookup finds a document by its name or its stem in a project's sources: the
    // name leads, since one source holds most of a project's nodes and a name is rare.
    index("tree_nodes_by_name").on(table.name, table.contextSourceId),
    index("tree_nodes_by_stem").on(table.stem, table.contextSourceId),
    index("tree_nodes_siblings")
      .on(table.contextSourceId, table.parentId, sql`${table.rank} COLLATE "C"`, table.id)
      .where(sql`${table.trashRecord} IS NULL`),
    index("tree_nodes_parent").on(table.parentId),
    index("tree_nodes_list").on(table.listId),
    index("tree_nodes_trashed").on(table.trashedAt).where(sql`${table.trashedAt} IS NOT NULL`),
  ],
);

/**
 * What a Work's tree shows differently from live: the resolved row of each node that differs,
 * each live node the Work's tree lacks (`deleted`), and each node that exists only in the Work.
 * Written only by the replay of that Work's tree, in the same transaction as `tree_nodes`.
 */
export const branchTreeNodes = pgTable(
  "branch_tree_nodes",
  {
    branchId: uuid("branch_id")
      .$type<BranchId>()
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    id: uuid("id").$type<DocumentId>().notNull(),
    /** The tree list the node is in; a Work's tree spans a project's list and the account's. */
    listId: uuid("list_id").$type<DocumentId>().notNull(),
    kind: text("kind").$type<NodeKind>().notNull(),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").$type<DocumentId>(),
    name: text("name").notNull(),
    extension: text("extension").notNull().default(""),
    fileType: text("file_type"),
    rank: text("rank").notNull(),
    /** Absent from this Work's view: deleted in the Work, or in Trash there. */
    deleted: boolean("deleted").notNull(),
    existsOnlyInDraft: boolean("exists_only_in_draft").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.branchId, table.id] }),
    foreignKey({
      name: "branch_tree_nodes_claimed_by_list",
      columns: [table.id, table.listId],
      foreignColumns: [treeNodeIds.id, treeNodeIds.listId],
    }).onDelete("cascade"),
    check("branch_tree_nodes_kind_valid", sql`${table.kind} IN ('folder', 'document')`),
    check(
      "branch_tree_nodes_file_type_of_document",
      sql`(${table.kind} = 'folder') = (${table.fileType} IS NULL)`,
    ),
    check("branch_tree_nodes_rank_present", sql`${table.rank} <> ''`),
    index("branch_tree_nodes_list").on(table.listId, table.branchId),
    index("branch_tree_nodes_walk").on(
      table.branchId,
      table.contextSourceId,
      table.parentId,
      table.name,
    ),
    index("branch_tree_nodes_siblings").on(
      table.branchId,
      table.contextSourceId,
      table.parentId,
      sql`${table.rank} COLLATE "C"`,
      table.id,
    ),
  ],
);
