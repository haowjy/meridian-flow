/**
 * The one tool policy (D13, D34): which tools an agent has. It never narrows a
 * tool's commands and never encodes access; permission and the file and action
 * policies decide what a call may change. Advertisement filters by it, dispatch
 * refuses a call outside it (D53), and a child never has a tool its parent lacks.
 */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import type { Tool } from "../../gateway/index.js";

/** Every model tool Flow publishes. Authoring tool lists may name only these. */
export const TOOL_CATALOG = [
  "read",
  "write",
  "work",
  "ls",
  "search",
  "skill",
  "ask_user",
  "spawn",
  "thread_message",
  "thread_report",
  "thread_ls",
  "thread_history",
  "return_result",
] as const;

/** The tool names an agent is advertised and may call. */
export type ToolPolicy = ReadonlySet<string>;

// ask_user is disabled until its rework (composer-attached input, subagent
// semantics): https://github.com/haowjy/meridian-flow/issues/601
const DISABLED = new Set(["ask_user"]);
const SUBAGENT_REPORT = "return_result";

/**
 * `((allow-list or full catalog) − disallowed − unavailable) + required`:
 * unavailable is the disabled tools, plus `return_result` for a primary;
 * required is `return_result` for a subagent.
 */
export function projectToolPolicy(
  configuration: Pick<ResolvedAgentConfiguration, "tools" | "disallowed-tools">,
  kind: Thread["kind"],
): ToolPolicy {
  const denied = new Set(configuration["disallowed-tools"]);
  const tools = new Set(
    (configuration.tools ?? TOOL_CATALOG).filter(
      (name) => !denied.has(name) && !DISABLED.has(name) && name !== SUBAGENT_REPORT,
    ),
  );
  if (kind === "subagent") tools.add(SUBAGENT_REPORT);
  return tools;
}

export function advertiseTools(tools: Tool[] | undefined, policy: ToolPolicy): Tool[] {
  return (tools ?? []).filter((tool) =>
    policy.has(tool.type === "function" ? tool.name : tool.kind),
  );
}

/** What the model reads when it calls a tool outside its policy (D53). */
export function missingToolRefusal(toolName: string): string {
  return `This agent has no "${toolName}" tool. Tell the user you can't do this here.`;
}

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
