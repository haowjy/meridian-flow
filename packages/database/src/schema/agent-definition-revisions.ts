/** Retained Agent source and definition rows, and the thread binding that points at them. */
import type {
  InvocationOverlay,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./_shared";
import { threads } from "./agent-threads";
import { projects } from "./content";
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
 * Each Save of one package: the package's own files or one import, of an account's `~/.agents/`
 * (`userId`) or a project's `.agents/` (`projectId`). Rows are only added: a package's saved
 * version is its row with the highest `seq`, a null revision means the package was removed, and
 * a chat binds a revision only when a row of its account or project points at its package.
 */
export const agentPackageSaves = pgTable(
  "agent_package_saves",
  {
    id: idColumn(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** `""` for the level's own files, `packages/<name>/` for an import. */
    folder: text("folder").notNull(),
    packageRevisionId: uuid("package_revision_id").references(() => agentPackageRevisions.id, {
      onDelete: "restrict",
    }),
    undoneSaveId: uuid("undone_save_id"),
    savedBy: text("saved_by", { enum: ["writer", "ai"] })
      .notNull()
      .default("writer"),
    /** Orders the rows; `created_at` is a transaction's start, so two Saves can tie or invert. */
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "agent_package_saves_one_owner",
      sql`(${table.userId} IS NULL) <> (${table.projectId} IS NULL)`,
    ),
    index("agent_package_saves_user_folder_seq").on(table.userId, table.folder, table.seq.desc()),
    index("agent_package_saves_project_folder_seq").on(
      table.projectId,
      table.folder,
      table.seq.desc(),
    ),
    index("agent_package_saves_package_revision").on(table.packageRevisionId),
  ],
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
