/**
 * Which tools an agent has, from its resolved configuration. The runtime enforces it (dispatch
 * refuses a call outside it, a child never has a tool its parent lacks).
 */
import type { ResolvedAgentConfiguration } from "./execution-knobs.js";

/** Every model tool Flow publishes by default. Authoring tool lists may name these and `OPT_IN_TOOLS`. */
export const TOOL_CATALOG = [
  "read",
  "write",
  "work",
  "ls",
  "grep",
  "skill",
  "ask_user",
  "spawn",
  "thread_message",
  "thread_report",
  "thread_ls",
  "thread_history",
  "return_result",
  "mcp_describe",
  "mcp_call",
  "mcp_run",
] as const;

/**
 * Tools an Agent has only when its file turns them on (`tools: {save_agents: allow}`); the full
 * catalog never includes them. Mars's vocabulary has no name for them, so Flow reads those rules
 * itself (`compile-package.ts`).
 */
export const OPT_IN_TOOLS = ["save_agents"] as const;

/** The tool names an agent is advertised and may call. */
export type ToolPolicy = ReadonlySet<string>;

const SUBAGENT_REPORT = "return_result";

/**
 * `((allow-list or full catalog) − disallowed − unavailable) + required`:
 * unavailable is the disabled tools, plus `return_result` for a primary and `ask_user` for a
 * subagent;
 * required is `return_result` for a subagent.
 */
export function projectToolPolicy(
  configuration: Pick<ResolvedAgentConfiguration, "tools" | "disallowed-tools">,
  kind: "primary" | "subagent",
): ToolPolicy {
  const denied = new Set(configuration["disallowed-tools"] ?? []);
  const tools = new Set(
    (configuration.tools ?? TOOL_CATALOG).filter(
      (name) => !denied.has(name) && name !== SUBAGENT_REPORT,
    ),
  );
  if (kind === "subagent") {
    // A subagent never asks the writer: it does the task or stops and reports what is missing.
    tools.delete("ask_user");
    tools.add(SUBAGENT_REPORT);
  }
  return tools;
}

/**
 * The tools `after` has that `before` lacks, in catalog order; empty means the spawn may run.
 * Both sides are projected as subagents, so `return_result` never counts.
 */
export function toolsBeyond(
  before: Pick<ResolvedAgentConfiguration, "tools" | "disallowed-tools">,
  after: Pick<ResolvedAgentConfiguration, "tools" | "disallowed-tools">,
): string[] {
  const held = projectToolPolicy(before, "subagent");
  return [...projectToolPolicy(after, "subagent")].filter((tool) => !held.has(tool));
}
