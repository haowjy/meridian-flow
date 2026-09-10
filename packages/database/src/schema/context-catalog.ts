/** Durable metadata catalog checkpoints and whole-commit replay log. */
import type { CatalogChange, CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./_shared";

export const contextCatalogScopeHeads = pgTable("context_catalog_scope_heads", {
  scopeKey: text("scope_key").primaryKey(),
  scope: jsonb("scope").$type<CatalogScope>().notNull(),
  generation: uuid("generation").notNull().defaultRandom(),
  headRevision: bigint("head_revision", { mode: "number" }).notNull().default(0),
  oldestRevision: bigint("oldest_revision", { mode: "number" }).notNull().default(1),
  updatedAt: updatedAt(),
});

export const contextCatalogEntries = pgTable(
  "context_catalog_entries",
  {
    scopeKey: text("scope_key")
      .notNull()
      .references(() => contextCatalogScopeHeads.scopeKey, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull(),
    entry: jsonb("entry").$type<CatalogEntry>().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeKey, table.entryId] }),
    index("context_catalog_entries_parent_idx").on(
      table.scopeKey,
      sql`(${table.entry}->>'parentId')`,
    ),
    index("context_catalog_entries_uri_idx").on(table.scopeKey, sql`(${table.entry}->>'uri')`),
  ],
);

export const contextCatalogCommits = pgTable(
  "context_catalog_commits",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    commitId: uuid("commit_id").notNull(),
    scopeKey: text("scope_key")
      .notNull()
      .references(() => contextCatalogScopeHeads.scopeKey, { onDelete: "cascade" }),
    firstRevision: bigint("first_revision", { mode: "number" }).notNull(),
    lastRevision: bigint("last_revision", { mode: "number" }).notNull(),
    changes: jsonb("changes").$type<readonly CatalogChange[]>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("context_catalog_commits_scope_revision_uq").on(
      table.scopeKey,
      table.firstRevision,
    ),
    index("context_catalog_commits_commit_idx").on(table.commitId),
  ],
);

/** Global ordering source; heads contain watermarks only, never identity state. */
export const contextAvailabilityGeneration = pgSequence("context_availability_generation_seq");

export const contextAvailabilityHeads = pgTable("context_availability_heads", {
  authorityKey: text("authority_key").primaryKey(),
  generation: bigint("generation", { mode: "bigint" }).notNull(),
  updatedAt: updatedAt(),
});
