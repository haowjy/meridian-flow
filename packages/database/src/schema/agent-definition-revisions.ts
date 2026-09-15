/** Retained Agent source/definition identity and account/system future-chat selection. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "./_shared";
import { threads } from "./agent-threads";
import { users } from "./users";

export const agentPackageRevisions = pgTable(
  "agent_package_revisions",
  {
    id: idColumn(),
    coordinate: text("coordinate").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contentDigest: text("content_digest").notNull(),
    source: jsonb("source").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_package_revisions_coordinate_digest").on(
      table.coordinate,
      table.contentDigest,
    ),
  ],
);

/** FK-backed retained dependency edges, installed before the dependent source is published. */
export const agentPackageDependencies = pgTable(
  "agent_package_dependencies",
  {
    packageRevisionId: uuid("package_revision_id")
      .notNull()
      .references(() => agentPackageRevisions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    dependencyRevisionId: uuid("dependency_revision_id")
      .notNull()
      .references(() => agentPackageRevisions.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.packageRevisionId, table.name] })],
);

export const agentDefinitionRevisions = pgTable(
  "agent_definition_revisions",
  {
    id: idColumn(),
    packageRevisionId: uuid("package_revision_id")
      .notNull()
      .references(() => agentPackageRevisions.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    definition: jsonb("definition").notNull(),
    definitionDigest: text("definition_digest").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_definition_revisions_package_slug").on(table.packageRevisionId, table.slug),
  ],
);

export const agentCatalogEntries = pgTable(
  "agent_catalog_entries",
  {
    id: idColumn(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    logicalKey: text("logical_key").notNull(),
    selectedRevisionId: uuid("selected_revision_id")
      .notNull()
      .references(() => agentDefinitionRevisions.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    nameSortKey: text("name_sort_key").notNull(),
    removed: boolean("removed").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agent_catalog_entries_personal_key")
      .on(table.ownerUserId, table.logicalKey)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    uniqueIndex("agent_catalog_entries_system_key")
      .on(table.logicalKey)
      .where(sql`${table.ownerUserId} IS NULL`),
    index("agent_catalog_entries_owner_name").on(table.ownerUserId, table.nameSortKey, table.id),
  ],
);

export const threadAgentBindings = pgTable("thread_agent_bindings", {
  threadId: uuid("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  definitionRevisionId: uuid("definition_revision_id")
    .notNull()
    .references(() => agentDefinitionRevisions.id, { onDelete: "restrict" }),
  configuration: jsonb("configuration").$type<ResolvedAgentConfiguration>().notNull(),
  createdAt: createdAt(),
});

/** Retains eligibility for revisions reserved before a future-chat pointer advances. */
export const agentCatalogRevisions = pgTable(
  "agent_catalog_revisions",
  {
    catalogEntryId: uuid("catalog_entry_id")
      .notNull()
      .references(() => agentCatalogEntries.id, { onDelete: "cascade" }),
    definitionRevisionId: uuid("definition_revision_id")
      .notNull()
      .references(() => agentDefinitionRevisions.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.catalogEntryId, table.definitionRevisionId] })],
);
