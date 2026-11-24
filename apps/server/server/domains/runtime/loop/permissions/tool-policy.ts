import type { ToolPolicy } from "@meridian/contracts/agents";
import type { Tool } from "@meridian-flow/runtime/gateway";

export function advertiseTools(tools: Tool[] | undefined, policy: ToolPolicy): Tool[] {
  return (tools ?? []).filter((tool) => policy.has(tool.name));
}

export function missingToolRefusal(toolName: string): string {
  return `This agent has no "${toolName}" tool.`;
}
