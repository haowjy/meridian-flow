/** Retained Agent source and definition rows, and the thread binding that points at them. */
import type {
  InvocationOverlay,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./_shared";
import { threads } from "./agent-threads";
import { users } from "./users";

export const agentPackageRevisions = pgTable(
  "agent_package_revisions",
  {
    id: idColumn(),
    coordinate: text("coordinate").notNull(),
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

export const agentDefinitionRevisions = pgTable(
  "agent_definition_revisions",
  {
    id: idColumn(),
    packageRevisionId: uuid("package_revision_id")
      .notNull()
      .references(() => agentPackageRevisions.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    /** The reader that produced this row: the Mars schema version and Flow's own rules version. */
    grammarVersion: text("grammar_version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** Null when the Agent is unavailable: nothing is stored for anything to run. */
    definition: jsonb("definition"),
    /** Every finding on the Agent, Mars's and Flow's. */
    diagnostics: jsonb("diagnostics").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_definition_revisions_package_slug_grammar").on(
      table.packageRevisionId,
      table.slug,
      table.grammarVersion,
    ),
    check(
      "agent_definition_revisions_unavailable_says_why",
      sql`${table.definition} IS NOT NULL OR jsonb_array_length(${table.diagnostics}) > 0`,
    ),
  ],
);

/**
 * The Agent revisions an account's picker has shown: a chat binds a revision only from its
 * owner's rows here or a built-in. Ids are content-derived, so rows grow with distinct versions.
 */
export const agentRevisionPicks = pgTable(
  "agent_revision_picks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    definitionRevisionId: uuid("definition_revision_id")
      .notNull()
      .references(() => agentDefinitionRevisions.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.definitionRevisionId] })],
);

export const threadAgentBindings = pgTable("thread_agent_bindings", {
  threadId: uuid("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  /** Null for an agent-less binding (generic subagent inheriting the caller's configuration). */
  definitionRevisionId: uuid("definition_revision_id").references(
    () => agentDefinitionRevisions.id,
    {
      onDelete: "restrict",
    },
  ),
  configuration: jsonb("configuration").$type<ResolvedAgentConfiguration>().notNull(),
  /** Raw spawn-time overlay; effective values are already resolved into `configuration`. */
  invocationOverlay: jsonb("invocation_overlay").$type<InvocationOverlay>(),
  /**
   * Packaged skills the user invoked with `/skill` in this thread, by slug,
   * pinned to the reference the body was read from. The only mutable
   * field: re-invoking replaces a slug's pin. Children start empty.
   */
  invokedSkills: jsonb("invoked_skills")
    .$type<Record<string, RetainedSkillReference>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});
