/**
 * The tool policy's runtime side (the projection is `@meridian/contracts/agents`): it never narrows a
 * tool's commands and never encodes access; permission and the file and action
 * policies decide what a call may change. Advertisement filters by it, dispatch
 * refuses a call outside it, and a child never has a tool its parent lacks.
 */
import type { ToolPolicy } from "@meridian/contracts/agents";
import type { Tool } from "@meridian-flow/runtime/gateway";

export function advertiseTools(tools: Tool[] | undefined, policy: ToolPolicy): Tool[] {
  return (tools ?? []).filter((tool) => policy.has(tool.name));
}

/** What the model reads when it calls a tool outside its policy. */
export function missingToolRefusal(toolName: string): string {
  return `This agent has no "${toolName}" tool.`;
}
