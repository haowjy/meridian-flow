/**
 * Agent gateway metadata: typed extraction of model/effort from Mars agent records.
 * Merges frontmatter (`meta`) with mars.toml overlays (`config`) so orchestrator
 * routing sees the same values package sync persisted.
 */
import { stringAt } from "./helpers.js";
import type { AgentDefinitionRecord, JsonObject } from "./types.js";

export type AgentEffortLevel = "low" | "medium" | "high" | "max";
export type AgentEffort = AgentEffortLevel | "disabled" | "adaptive";

export interface AgentGatewayMeta {
  model?: string;
  effort?: AgentEffort;
}

const EFFORT_LEVELS = new Set<AgentEffortLevel>(["low", "medium", "high", "max"]);
const EFFORT_VALUES = new Set<AgentEffort>([
  "low",
  "medium",
  "high",
  "max",
  "disabled",
  "adaptive",
]);

/** Normalize Mars effort strings from frontmatter or mars.toml overlays. */
export function normalizeAgentEffort(value: unknown): AgentEffort | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return EFFORT_VALUES.has(normalized as AgentEffort) ? (normalized as AgentEffort) : undefined;
}

/** Type-extract model/effort while preserving other frontmatter fields. */
export function normalizeAgentMetaFields(meta: JsonObject): JsonObject {
  const model = stringAt(meta.model);
  const effort = normalizeAgentEffort(meta.effort);
  const { effort: _ignoredEffort, model: _ignoredModel, ...rest } = meta;
  return {
    ...rest,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** Merge agent frontmatter and package overlay into gateway routing params. */
export function extractAgentGatewayMeta(agent: AgentDefinitionRecord): AgentGatewayMeta {
  const model = stringAt(agent.config.model) ?? stringAt(agent.meta.model);
  const effort =
    normalizeAgentEffort(agent.config.effort) ?? normalizeAgentEffort(agent.meta.effort);
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function isAgentEffortLevel(value: AgentEffort): value is AgentEffortLevel {
  return EFFORT_LEVELS.has(value as AgentEffortLevel);
}
