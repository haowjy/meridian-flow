/**
 * Presence-preserving Mars model/effort normalization before immutable compilation.
 */
import { AGENT_EFFORT_ALIASES, AGENT_EFFORT_VALUES } from "@meridian/contracts/agents";
import { stringAt } from "./helpers.js";
import type { JsonObject } from "./types.js";

// Authoring accepts canonical values plus alias keys; the compiler folds aliases.
const ACCEPTED_EFFORTS = new Set<string>([
  ...AGENT_EFFORT_VALUES,
  ...Object.keys(AGENT_EFFORT_ALIASES),
]);

/** Normalize Mars effort strings from frontmatter or mars.toml overlays. */
function normalizeAgentEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return ACCEPTED_EFFORTS.has(normalized) ? normalized : undefined;
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
