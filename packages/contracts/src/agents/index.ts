import { z } from "zod";
import { isUuid } from "../request-id.js";
import {
  type InvocationPatch,
  type ReasoningLevel,
  reasoningLevelSchema,
} from "./execution-knobs.js";
import { type AgentPackageStatus, agentPackageStatusSchema } from "./save.js";

export * from "./execution-knobs.js";
export * from "./location.js";
export * from "./save.js";
export * from "./tool-policy.js";

export const agentSelectionSchema = z.strictObject({
  slug: z.string().min(1),
  definitionRevisionId: z
    .string()
    .refine((value): boolean => isUuid(value), "must be a canonical UUID")
    .toLowerCase(),
});
export type AgentSelection = z.infer<typeof agentSelectionSchema>;
export type AgentLevel = "builtin" | "user" | "project";
export interface AgentCatalogItem {
  selection: AgentSelection | null;
  slug: string;
  path: string | null;
  name: string;
  description: string;
  model: string | null;
  effort: ReasoningLevel | null;
  primary: boolean;
  level: AgentLevel;
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
      effort: reasoningLevelSchema.nullable(),
      primary: z.boolean(),
      level: agentLevelSchema,
      shadows: z.array(agentLevelSchema),
      unavailableReasons: z.array(z.string()),
    }),
  ),
}) satisfies z.ZodType<AgentCatalog>;

export interface AgentFileStatus {
  kind: "agent" | "skill";
  slug: string;
  level: AgentLevel;
  path: string;
  unavailableReasons: string[];
  saved: boolean;
  savedVersionInUse: boolean;
  pickable: boolean;
  shadows: AgentLevel[];
  hiddenBy: AgentLevel | null;
  change: "added" | "changed" | null;
}
export interface AgentFiles {
  files: AgentFileStatus[];
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
export const savedAgentFileQuerySchema = z.object({ level: agentLevelSchema, path: z.string() });
export const savedAgentFileSchema = z.object({ text: z.string() });

export const threadAgentSchema = z.object({
  selection: agentSelectionSchema,
  name: z.string(),
  description: z.string(),
  text: z.string(),
  stale: z.boolean(),
  model: z.string(),
  effort: reasoningLevelSchema.nullable(),
  unavailableReasons: z.array(z.string()),
});
export type ThreadAgent = z.infer<typeof threadAgentSchema>;

export interface InvocationOverlay {
  appendSystemPrompt?: string;
  overrides?: InvocationPatch;
}

export type AgentSource = "builtin" | "package" | "user";

export const GENERIC_SUBAGENT_SLUG = "subagent";
export const GENERIC_SUBAGENT_NAME = "Subagent";
export const GENERIC_AGENT_BODY = "";
