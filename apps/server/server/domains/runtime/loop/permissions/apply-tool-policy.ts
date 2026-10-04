/** Applies the tool policy to advertisement and to dispatch: a call outside it is refused (D53). */
import type { Tool } from "../../gateway/index.js";
import type { ToolPolicy } from "./project-tool-policy.js";
import type { PermissionGate } from "./types.js";

export function permissionGateFromToolPolicy(policy: ToolPolicy): PermissionGate {
  return {
    check(toolName) {
      if (policy.has(toolName)) return { allowed: true };
      return {
        allowed: false,
        kind: "permission_denied",
        reason: `This agent has no "${toolName}" tool. Tell the user you can't do this here.`,
      };
    },
  };
}

export function advertiseTools(tools: Tool[] | undefined, policy: ToolPolicy): Tool[] {
  return (tools ?? []).filter((tool) =>
    policy.has(tool.type === "function" ? tool.name : tool.kind),
  );
}
