import { OPT_IN_TOOLS, TOOL_CATALOG } from "@meridian/contracts/agents";
import type { Gateway } from "@meridian-flow/runtime/gateway";
import type { CompiledAgentDefinition } from "../packages/index.js";

const supported = new Set([
  "name",
  "description",
  "model",
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
const catalog = new Set<string>([...TOOL_CATALOG, ...OPT_IN_TOOLS]);
export function agentExecutionUnavailableReasons(
  definition: CompiledAgentDefinition,
  gateway: Pick<Gateway, "listModels">,
  resolvedModel: string,
): string[] {
  const reasons = agentDefinitionUnsupportedReasons(definition);
  reasons.push(...agentModelUnavailableReasons(gateway, resolvedModel));
  return reasons;
}

export function agentModelUnavailableReasons(
  gateway: Pick<Gateway, "listModels">,
  model: string,
): string[] {
  if (!gateway.listModels().some((item) => item.id === model)) {
    return [`The model ${model} isn't available.`];
  }
  return [];
}

export function agentDefinitionUnsupportedReasons(definition: CompiledAgentDefinition): string[] {
  const reasons: string[] = [];
  const meta = definition.metadata;
  for (const key of Object.keys(meta)) {
    if (!supported.has(key)) reasons.push(`Unsupported Agent field: ${key}`);
  }
  for (const name of meta.tools ?? []) {
    if (!catalog.has(name)) reasons.push(`Unknown tool in tools: ${name}`);
  }
  return reasons;
}
