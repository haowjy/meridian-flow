/**
 * spawn-output — the spawn tool result as the transcript persists it.
 *
 * `AgentReport.costMillicredits` stays on the internal report, the spawn
 * ledger, and the tree budget, but the value written as the spawn tool's output
 * must not carry it: the writer's card never shows cost, and nothing else
 * downstream should either.
 */
import type { JsonValue } from "@meridian/contracts/threads";

export function spawnOutputForTranscript(output: JsonValue): JsonValue {
  if (!isRecord(output) || output.status !== "completed") return output;
  const report = output.report;
  if (!isRecord(report)) return output;
  const reportWithoutCost = { ...report };
  delete reportWithoutCost.costMillicredits;
  return { ...output, report: reportWithoutCost };
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
