/** Agent source, account/system catalog and retained conversation configuration contracts. */
import { z } from "zod";
import { isUuid } from "../request-id.js";
import {
  type InvocationPatch,
  type ReasoningChoice,
  reasoningChoiceSchema,
} from "./execution-knobs.js";
import { type AgentPackageStatus, agentPackageStatusSchema } from "./save.js";

export * from "./execution-knobs.js";
export * from "./location.js";
export * from "./save.js";
export * from "./tool-policy.js";

/**
 * The Agent a writer picked: the name the picker shows and the exact revision it showed. A chat
 * binds that revision, so an Agent file edited after the picker loaded changes only later chats.
 */
export const agentSelectionSchema = z.strictObject({
  slug: z.string().min(1),
  definitionRevisionId: z
    .string()
    .refine((value): boolean => isUuid(value), "must be a canonical UUID")
    .toLowerCase(),
});
export type AgentSelection = z.infer<typeof agentSelectionSchema>;
/** Which level an Agent came from. A higher level hides the same name below it. */
export type AgentLevel = "builtin" | "user" | "project";
export interface AgentCatalogItem {
  /** Null for a name two packages bring: it is held, unavailable, and nothing to pick. */
  selection: AgentSelection | null;
  slug: string;
  /**
   * The Agent's file, relative to its level's root (`agentsRootOf`), as `AgentFileStatus.path`.
   * Null exactly when `selection` is: two packages bring the name, so there are two files.
   */
  path: string | null;
  name: string;
  description: string;
  model: string | null;
  /** The Agent's own reasoning setting, in the wire vocabulary; null when its file sets none. */
  effort: ReasoningChoice | null;
  /** False for an Agent only other Agents call: it starts no chat, so the picker leaves it out. */
  primary: boolean;
  level: AgentLevel;
  /** Levels below this one that have an Agent of the same name, now hidden. */
  shadows: AgentLevel[];
  unavailableReasons: string[];
}
export interface AgentCatalog {
  agents: AgentCatalogItem[];
}

const agentLevelSchema = z.enum(["builtin", "user", "project"]);
export const agentCatalogSchema = z.object({
  agents: z.array(
    z.object({
      selection: agentSelectionSchema.nullable(),
      slug: z.string().min(1),
      path: z.string().nullable(),
      name: z.string(),
      description: z.string(),
      model: z.string().nullable(),
      effort: reasoningChoiceSchema.nullable(),
      primary: z.boolean(),
      level: agentLevelSchema,
      shadows: z.array(agentLevelSchema),
      unavailableReasons: z.array(z.string()),
    }),
  ),
}) satisfies z.ZodType<AgentCatalog>;

/**
 * What Mars made of one Agent or skill file, at its level, whether or not it wins its name. The
 * Agents tab and an open Agent file read this; the picker reads the catalog.
 */
export interface AgentFileStatus {
  kind: "agent" | "skill";
  /** The name the writer picks by: the file's, or `name__package` after a clash. */
  slug: string;
  level: AgentLevel;
  /** Relative to the level's root (`agentsRootOf`): `agents/critic.md`, `packages/x/skills/y/SKILL.md`. */
  path: string;
  /**
   * Why the Agent can't run though Mars reads it (a model the account can't use): this text's, or
   * while this text has an Error, its saved version's. Its Errors are its package's findings.
   */
  unavailableReasons: string[];
  /** The saved version has this file; without it, new chats do not see the item at all. */
  saved: boolean;
  /** The saved version of this item runs, so new chats use it even while this text has an Error. */
  savedVersionInUse: boolean;
  /**
   * Whether the writer picks it: from the Agent picker for an Agent, the `/` menu for a skill.
   * False for one only Agents use (a subagent, a skill the model loads).
   */
  pickable: boolean;
  /** Levels below this one that have the same name, which the saved version of this file hides. */
  shadows: AgentLevel[];
  /** The level above that has the same name and hides the saved version of this file; null when it is used or not saved. */
  hiddenBy: AgentLevel | null;
  /** Against the saved version of its package; null when unchanged since the Save (a deleted file has no row). */
  change: "added" | "changed" | null;
}
export interface AgentFiles {
  files: AgentFileStatus[];
  /** Every package of the writer's levels, the removed ones included, with its Save state. */
  packages: AgentPackageStatus[];
}
export const agentFilesSchema = z.object({
  files: z.array(
    z.object({
      kind: z.enum(["agent", "skill"]),
      slug: z.string().min(1),
      level: agentLevelSchema,
      path: z.string().min(1),
      unavailableReasons: z.array(z.string()),
      saved: z.boolean(),
      savedVersionInUse: z.boolean(),
      pickable: z.boolean(),
      shadows: z.array(agentLevelSchema),
      hiddenBy: agentLevelSchema.nullable(),
      change: z.enum(["added", "changed"]).nullable(),
    }),
  ),
  packages: z.array(agentPackageStatusSchema),
}) satisfies z.ZodType<AgentFiles>;
/**
 * `GET /api/agents/saved-file`: a file's text as its package's latest Save holds it, by
 * level-relative path; a built-in's as shipped, since built-ins are not documents.
 */
export const savedAgentFileQuerySchema = z.object({ level: agentLevelSchema, path: z.string() });
export const savedAgentFileSchema = z.object({ text: z.string() });

/**
 * The Agent a started chat runs, as its next turn runs it: the chat's own row in the picker comes
 * from this alone, since the catalog's newest save takes over only at a compaction.
 */
export const threadAgentSchema = z.object({
  selection: agentSelectionSchema,
  name: z.string(),
  description: z.string(),
  text: z.string(),
  stale: z.boolean(),
  /** The model and reasoning the next turn runs with no per-chat override. */
  model: z.string(),
  effort: reasoningChoiceSchema.nullable(),
  /** Why the Agent can't run on that model now; empty when it can. */
  unavailableReasons: z.array(z.string()),
});
export type ThreadAgent = z.infer<typeof threadAgentSchema>;

/** Raw overlay retained for inspection/export; effective values live in `configuration`. */
export interface InvocationOverlay {
  appendSystemPrompt?: string;
  overrides?: InvocationPatch;
}

/** Where an agent definition came from, for grouping and provenance badges. */
export type AgentSource = "builtin" | "package" | "user";

/** Identity vocabulary for the agent-less generic subagent (a binding with no Agent revision). */
export const GENERIC_SUBAGENT_SLUG = "subagent";
export const GENERIC_SUBAGENT_NAME = "Subagent";
/** Host-owned empty default body, matching the seeded General agent's empty body. */
export const GENERIC_AGENT_BODY = "";
