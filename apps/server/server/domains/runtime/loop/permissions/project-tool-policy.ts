/**
 * The one tool policy (D13, D34): which tools an agent has. It never narrows a
 * tool's commands and never encodes access; permission and the file and action
 * policies decide what a call may change.
 */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";

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
