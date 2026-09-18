/**
 * spawn-report — reads the writer-facing report out of a `spawn` ToolView.
 *
 * The tool output is a `SpawnResult`; the card shows only who ran and what came
 * back. Cost is deliberately not read here: the spawn dispatch already omits it
 * from the output the transcript persists.
 */
import { t } from "@lingui/core/macro";
import type { JsonValue } from "@meridian/contracts/protocol";

import { descriptorFor } from "./command-descriptor";
import type { ToolView } from "./group-delivery-segments";
import { humanizeSkillSlug, stringInput, toolInputObject } from "./tool-command";

export type SpawnReportStatus = "running" | "completed" | "failed";

export type SpawnReportView = {
  agentName: string;
  title: string | null;
  summary: string | null;
  status: SpawnReportStatus;
  /** Absent for a failure that happened before a child thread existed. */
  childThreadId: string | null;
};

export function spawnReportFromTool(tool: ToolView): SpawnReportView | null {
  if (tool.toolName !== "spawn") return null;

  const input = toolInputObject(tool);
  const agentName = spawnAgentName(stringInput(input, "agent"));
  const title = stringInput(input, "description") ?? null;
  const output = asRecord(tool.output);
  if (!output) {
    return { agentName, title, summary: null, status: "running", childThreadId: null };
  }
  const status = output.status;

  if (status === "completed") {
    const report = asRecord(output.report);
    if (!report) return null;
    return {
      agentName,
      title,
      summary: asString(report.summary),
      status: "completed",
      childThreadId: asString(report.threadId),
    };
  }

  // A background spawn returns before its report exists; the live card just
  // acknowledges the run and offers the door until the helper result lands.
  if (status === "background") {
    return {
      agentName,
      title,
      summary: null,
      status: "running",
      childThreadId: asString(output.threadId),
    };
  }

  if (tool.isError || status === "error") {
    return {
      agentName,
      title,
      summary: descriptorFor(tool).failureVerb("direct"),
      status: "failed",
      childThreadId: null,
    };
  }

  return null;
}

/** An omitted or empty `agent` is the generic helper; a slug reads as a name. */
function spawnAgentName(agent: string | undefined): string {
  return agent ? humanizeSkillSlug(agent) : t`Helper`;
}

function asRecord(value: JsonValue | null): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
