import type { ContextSourceId, DocumentId } from "@meridian/contracts";
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
import { treeLists } from "./collab";
import { contextSources } from "./content";
import { draftIdColumn } from "./drafts";

type NodeKind = "folder" | "document";

export const treeNodeIds = pgTable(
  "tree_node_ids",
  {
    id: uuid("id").$type<DocumentId>().primaryKey(),
    listId: uuid("list_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => treeLists.id, { onDelete: "cascade" }),
  },
  (table) => [unique("tree_node_ids_id_list").on(table.id, table.listId)],
);

export const treeNodes = pgTable(
  "tree_nodes",
  {
    id: uuid("id").$type<DocumentId>().primaryKey(),
    listId: uuid("list_id").$type<DocumentId>().notNull(),
    kind: text("kind").$type<NodeKind>().notNull(),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").$type<DocumentId>(),
    name: text("name").notNull(),
    suffix: text("suffix"),
    segment: text("segment").generatedAlwaysAs(sql`name || coalesce('~' || suffix, '')`),
    extension: text("extension").notNull().default(""),
    stem: text("stem").generatedAlwaysAs(
      sql`CASE WHEN extension <> '' THEN left(name, -(length(extension) + 1)) ELSE name END`,
    ),
    fileType: text("file_type"),
    rank: text("rank").notNull(),
    locationVersion: bigint("location_version", { mode: "bigint" }).notNull().default(sql`0`),
    trashRecord: text("trash_record"),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    trashedBy: text("trashed_by"),
  },
  (table) => [
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
    check(
      "tree_nodes_trashed_by_shape",
      sql`${table.trashedBy} IS NULL OR ${table.trashRecord} IS NOT NULL`,
    ),
    index("tree_nodes_walk").on(table.contextSourceId, table.parentId, table.segment),
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

export const draftTreeNodes = pgTable(
  "draft_tree_nodes",
  {
    draftId: draftIdColumn("draft_id").notNull(),
    id: uuid("id").$type<DocumentId>().notNull(),
    listId: uuid("list_id").$type<DocumentId>().notNull(),
    kind: text("kind").$type<NodeKind>().notNull(),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").$type<DocumentId>(),
    name: text("name").notNull(),
    suffix: text("suffix"),
    segment: text("segment").generatedAlwaysAs(sql`name || coalesce('~' || suffix, '')`),
    extension: text("extension").notNull().default(""),
    fileType: text("file_type"),
    rank: text("rank").notNull(),
    deleted: boolean("deleted").notNull(),
    existsOnlyInDraft: boolean("exists_only_in_draft").notNull(),
    changed: boolean("changed").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.id] }),
    foreignKey({
      name: "draft_tree_nodes_claimed_by_list",
      columns: [table.id, table.listId],
      foreignColumns: [treeNodeIds.id, treeNodeIds.listId],
    }).onDelete("cascade"),
    check("draft_tree_nodes_kind_valid", sql`${table.kind} IN ('folder', 'document')`),
    check(
      "draft_tree_nodes_file_type_of_document",
      sql`(${table.kind} = 'folder') = (${table.fileType} IS NULL)`,
    ),
    check("draft_tree_nodes_rank_present", sql`${table.rank} <> ''`),
    index("draft_tree_nodes_list").on(table.listId, table.draftId),
    index("draft_tree_nodes_walk").on(
      table.draftId,
      table.contextSourceId,
      table.parentId,
      table.segment,
    ),
    index("draft_tree_nodes_siblings").on(
      table.draftId,
      table.contextSourceId,
      table.parentId,
      sql`${table.rank} COLLATE "C"`,
      table.id,
    ),
  ],
);
