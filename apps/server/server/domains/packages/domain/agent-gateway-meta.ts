/**
 * Presence-preserving Mars model/effort normalization before immutable compilation.
 */
import { stringAt } from "./helpers.js";
import type { JsonObject } from "./types.js";

export type AgentEffortLevel = "low" | "medium" | "high" | "max";
export type AgentEffort = AgentEffortLevel | "disabled" | "adaptive";

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

/** Preserve invalid source values so compilation can diagnose them without silent fallback. */
export function normalizeAgentMetaFields(meta: JsonObject): JsonObject {
  const model = stringAt(meta.model);
  const effort = normalizeAgentEffort(meta.effort);
  return {
    ...meta,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function isAgentEffortLevel(value: AgentEffort): value is AgentEffortLevel {
  return EFFORT_LEVELS.has(value as AgentEffortLevel);
}
