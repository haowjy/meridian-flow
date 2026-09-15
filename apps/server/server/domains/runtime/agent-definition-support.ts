/** Shared execution-support checks for immutable Agent selection and turn preparation. */
import type { CompiledAgentDefinition } from "../packages/index.js";
import type { Gateway } from "./gateway/index.js";

const supported = new Set([
  "name",
  "description",
  "model",
  "effort",
  "mode",
  "model-invocable",
  "user-invocable",
  "skills",
  "subagents",
]);
export function agentDefinitionUnavailableReasons(
  definition: CompiledAgentDefinition,
  gateway: Pick<Gateway, "listModels">,
): string[] {
  const reasons = agentDefinitionUnsupportedReasons(definition);
  const meta = definition.metadata;
  if (meta.subagents?.length) reasons.push("Bound subagent delegation is not available yet.");
  if (!meta.model || !gateway.listModels?.().some((model) => model.id === meta.model)) {
    reasons.push("The Agent's configured model is unavailable.");
  }
  return reasons;
}

export function agentDefinitionUnsupportedReasons(definition: CompiledAgentDefinition): string[] {
  const reasons: string[] = [];
  const meta = definition.metadata;
  for (const key of Object.keys(meta)) {
    if (!supported.has(key)) reasons.push(`Unsupported Agent field: ${key}`);
  }
  if (
    meta.skills?.load?.length ||
    (meta.skills && "available" in meta.skills && meta.skills.available?.length)
  )
    reasons.push("Agent skill loading is not available yet.");
  return reasons;
}
