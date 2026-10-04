/** A child's tools are always a subset of its parent's, with `return_result` added (D13). */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import { projectToolPolicy } from "./project-tool-policy.js";

/**
 * The child's tools its parent doesn't have, in catalog order; empty means the
 * spawn may run. Both sides are projected as subagents, so `return_result`
 * never counts.
 */
export function toolsBeyondParent(
  parent: ResolvedAgentConfiguration,
  child: ResolvedAgentConfiguration,
): string[] {
  const parentTools = projectToolPolicy(parent, "subagent");
  return [...projectToolPolicy(child, "subagent")].filter((tool) => !parentTools.has(tool));
}
