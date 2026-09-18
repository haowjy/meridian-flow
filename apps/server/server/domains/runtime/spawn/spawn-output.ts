/**
 * spawn-output — transcript-facing spawn payloads.
 *
 * Cost stays on the internal report / tree budget, never on the tool output.
 * The writer-facing surface is a helper-result custom block, same family as
 * ask_user's custom card: the spawn tool_use/tool_result stay protocol-only.
 */
import type { HelperResultProps } from "@meridian/contracts/components";
import type { JsonValue } from "@meridian/contracts/threads";

export function spawnOutputForTranscript(output: JsonValue): JsonValue {
  if (!isRecord(output) || output.status !== "completed") return output;
  const report = output.report;
  if (!isRecord(report)) return output;
  const reportWithoutCost = { ...report };
  delete reportWithoutCost.costMillicredits;
  return { ...output, report: reportWithoutCost };
}

export function spawnHelperCardProps(input: {
  agent?: string;
  description?: string;
  parentTurnId: string;
  childThreadId?: string;
  output?: JsonValue;
}): HelperResultProps {
  const slug = input.agent?.trim() || "helper";
  const base: HelperResultProps = {
    agentSlug: slug,
    agentName: helperAgentName(slug),
    status: "running",
    summary: "",
    childThreadId: input.childThreadId ?? "",
    parentTurnId: input.parentTurnId,
    ...(input.description !== undefined ? { title: input.description } : {}),
  };
  const output = input.output;
  if (!isRecord(output)) return base;
  if (output.status === "completed" && isRecord(output.report)) {
    return {
      ...base,
      status: "completed",
      summary: typeof output.report.summary === "string" ? output.report.summary : "",
      childThreadId:
        typeof output.report.threadId === "string" ? output.report.threadId : base.childThreadId,
      ...(output.report.payload !== undefined ? { payload: output.report.payload } : {}),
    };
  }
  if (output.status === "error") {
    const error = isRecord(output.error) ? output.error : null;
    return {
      ...base,
      status: "failed",
      summary: typeof error?.message === "string" ? error.message : "",
    };
  }
  return base;
}

function helperAgentName(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
