import type { ResolvedAgentConfiguration } from "./execution-knobs.js";

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

export const OPT_IN_TOOLS = ["save_agents"] as const;

export type ToolPolicy = ReadonlySet<string>;

const SUBAGENT_REPORT = "return_result";

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
    tools.delete("ask_user");
    tools.add(SUBAGENT_REPORT);
  }
  return tools;
}

export function toolsBeyond(
  before: Pick<ResolvedAgentConfiguration, "tools" | "disallowed-tools">,
  after: Pick<ResolvedAgentConfiguration, "tools" | "disallowed-tools">,
): string[] {
  const held = projectToolPolicy(before, "subagent");
  return [...projectToolPolicy(after, "subagent")].filter((tool) => !held.has(tool));
}
