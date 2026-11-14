/** Agent source, account/system catalog and retained conversation configuration contracts. */
import { z } from "zod";
import { isUuid } from "../request-id.js";
import type { InvocationPatch } from "./execution-knobs.js";

export * from "./execution-knobs.js";
export * from "./location.js";

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
  name: string;
  description: string;
  model: string | null;
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
      name: z.string(),
      description: z.string(),
      model: z.string().nullable(),
      level: agentLevelSchema,
      shadows: z.array(agentLevelSchema),
      unavailableReasons: z.array(z.string()),
    }),
  ),
}) satisfies z.ZodType<AgentCatalog>;

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
