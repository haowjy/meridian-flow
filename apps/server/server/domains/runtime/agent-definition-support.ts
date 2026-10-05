/** Shared execution-support checks for immutable Agent selection and turn preparation. */
import type { CompiledAgentDefinition } from "../packages/index.js";
import type { Gateway } from "./gateway/index.js";
import { TOOL_CATALOG } from "./loop/permissions/project-tool-policy.js";

const supported = new Set([
  "name",
  "description",
  "model",
  "autocompact",
  "autocompact_pct",
  "effort",
  "mode",
  "permission",
  "model-invocable",
  "user-invocable",
  "skills",
  "subagents",
  "tools",
  "disallowed-tools",
]);
const catalog = new Set<string>(TOOL_CATALOG);
export function agentExecutionUnavailableReasons(
  definition: CompiledAgentDefinition,
  gateway: Pick<Gateway, "listModels">,
  resolvedModel: string,
): string[] {
  const reasons = agentDefinitionUnsupportedReasons(definition);
  reasons.push(...agentModelUnavailableReasons(gateway, resolvedModel));
  return reasons;
}

/** Host-availability check for a model id, independent of any Agent definition. */
export function agentModelUnavailableReasons(
  gateway: Pick<Gateway, "listModels">,
  model: string,
): string[] {
  if (!gateway.listModels?.().some((item) => item.id === model)) {
    return ["The Agent's configured model is unavailable."];
  }
  return [];
}

export function agentDefinitionUnsupportedReasons(definition: CompiledAgentDefinition): string[] {
  const reasons: string[] = [];
  const meta = definition.metadata;
  for (const key of Object.keys(meta)) {
    if (!supported.has(key)) reasons.push(`Unsupported Agent field: ${key}`);
  }
  // An unknown name in disallowed-tools denies nothing that exists, so it is ignored.
  for (const name of meta.tools ?? []) {
    if (!catalog.has(name)) reasons.push(`Unknown tool in tools: ${name}`);
  }
  return reasons;
}
