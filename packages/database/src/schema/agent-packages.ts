import type {
  AgentDefinitionId,
  ProjectId,
  SkillId,
  UserId,
  UserInstalledSkillId,
} from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, jsonbDefault, updatedAt } from "./_shared";
import { projects } from "./content";
import { users } from "./users";

export const agentDefinitions = pgTable(
  "agent_definitions",
  {
    id: idColumn<AgentDefinitionId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    mode: text("mode").notNull().default("primary"),
    sourceType: text("source_type").notNull().default("builtin"),
    baseDefinitionId: uuid("base_definition_id").$type<AgentDefinitionId>(),
    sourcePackageId: text("source_package_id"),
    sourceVersion: text("source_version"),
    config: jsonbDefault("config"),
    sortOrder: integer("sort_order").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agent_definitions_project_slug").on(table.projectId, table.slug),
    index("agent_definitions_project_sort_enabled")
      .on(table.projectId, table.sortOrder)
      .where(sql`${table.enabled} = true`),
    index("agent_definitions_project_mode_enabled")
      .on(table.projectId, table.mode)
      .where(sql`${table.enabled} = true`),
  ],
);

export const skills = pgTable(
  "skills",
  {
    id: idColumn<SkillId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    type: text("type").notNull().default("reference"),
    modelInvocable: boolean("model_invocable").notNull().default(true),
    userInvocable: boolean("user_invocable").notNull().default(true),
    isGlobal: boolean("is_global").notNull().default(false),
    content: text("content").notNull().default(""),
    config: jsonbDefault("config"),
    sourceType: text("source_type").notNull().default("builtin"),
    baseSkillId: uuid("base_skill_id").$type<SkillId>(),
    sourcePackageId: text("source_package_id"),
    sourcePackageVersion: text("source_package_version"),
    isModified: boolean("is_modified").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("skills_project_slug").on(table.projectId, table.slug),
    index("skills_project_type_sort_enabled")
      .on(table.projectId, table.type, table.sortOrder)
      .where(sql`${table.enabled} = true`),
    index("skills_project_global_enabled")
      .on(table.projectId)
      .where(sql`${table.isGlobal} = true AND ${table.enabled} = true`),
    check("skills_type_valid", sql`${table.type} IN ('principle', 'guardrail', 'reference')`),
    check("skills_source_type_valid", sql`${table.sourceType} IN ('builtin', 'package', 'user')`),
  ],
);

export const userInstalledSkills = pgTable(
  "user_installed_skills",
  {
    id: idColumn<UserInstalledSkillId>(),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    type: text("type").notNull().default("reference"),
    modelInvocable: boolean("model_invocable").notNull().default(true),
    userInvocable: boolean("user_invocable").notNull().default(true),
    content: text("content").notNull().default(""),
    config: jsonbDefault("config"),
    sourceType: text("source_type").notNull().default("user"),
    sourcePackageId: text("source_package_id"),
    sourcePackageVersion: text("source_package_version"),
    baseSkillId: uuid("base_skill_id").$type<UserInstalledSkillId>(),
    isModified: boolean("is_modified").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("user_installed_skills_user_slug").on(table.userId, table.slug)],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentDefinitionId: uuid("agent_definition_id")
      .$type<AgentDefinitionId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .$type<SkillId>()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    loadingMode: text("loading_mode").notNull().default("available"),
    modelInvocable: boolean("model_invocable"),
    userInvocable: boolean("user_invocable"),
  },
  (table) => [
    primaryKey({ columns: [table.agentDefinitionId, table.skillId] }),
    check(
      "agent_skills_loading_mode_valid",
      sql`${table.loadingMode} IN ('preloaded', 'available')`,
    ),
  ],
);

export const agentSubagents = pgTable(
  "agent_subagents",
  {
    parentAgentId: uuid("parent_agent_id")
      .$type<AgentDefinitionId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: "cascade" }),
    childAgentId: uuid("child_agent_id")
      .$type<AgentDefinitionId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.parentAgentId, table.childAgentId] }),
    check("agent_subagents_no_self", sql`${table.parentAgentId} != ${table.childAgentId}`),
  ],
);

// Self-FKs: base_definition_id, base_skill_id, user_installed_skills.base_skill_id in custom SQL
