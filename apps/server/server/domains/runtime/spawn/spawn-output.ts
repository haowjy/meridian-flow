/**
 * spawn-output — transcript-facing spawn payloads.
 *
 * Cost stays on the internal report / tree budget, never on the tool output.
 * The writer-facing surface is a helper-result custom block, same family as
 * ask_user's custom card: the spawn tool_use/tool_result stay protocol-only.
 */
import { GENERIC_SUBAGENT_SLUG } from "@meridian/contracts/agents";
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
  const slug = input.agent?.trim() || GENERIC_SUBAGENT_SLUG;
  const base: HelperResultProps = {
    agentSlug: slug,
    agentName: helperAgentName(slug),
    status: "running",
    parentTurnId: input.parentTurnId,
    ...(input.description !== undefined ? { title: input.description } : {}),
    ...(input.childThreadId !== undefined ? { childThreadId: input.childThreadId } : {}),
  };
  const output = input.output;
  if (!isRecord(output)) return base;
  if (output.status === "completed" && isRecord(output.report)) {
    return {
      ...base,
      status: "completed",
      ...(typeof output.report.summary === "string" ? { summary: output.report.summary } : {}),
      ...(typeof output.report.threadId === "string"
        ? { childThreadId: output.report.threadId }
        : {}),
      ...(output.report.payload !== undefined ? { payload: output.report.payload } : {}),
    };
  }
  if (output.status === "error") {
    const error = isRecord(output.error) ? output.error : null;
    return {
      ...base,
      status: "failed",
      ...(typeof error?.message === "string" ? { summary: error.message } : {}),
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
