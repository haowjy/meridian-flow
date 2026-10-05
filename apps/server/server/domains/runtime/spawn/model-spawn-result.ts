/**
 * The model's text for a `spawn` or `thread_message` result (D8), rendered
 * from the typed `SpawnResult` the executor keeps beside it. A report reads
 * as it does in `thread_report` and `thread_history`. The text names the
 * child by its handle only: execution and thread ids stay in the typed result
 * for the app.
 */
import type { SpawnResult } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";
import { type InvalidArgumentsResult, renderInvalidArguments } from "../tools/invalid-arguments.js";
import { renderRefusal, renderReportBlock, reportContent } from "./history-result.js";

export const queuedNoReplyCopy =
  "Message queued. No reply is pushed back; the target's response is readable in its transcript.";
export const queuedNotifyCopy = (handle: string) =>
  `Message queued. You'll be notified when ${handle} finishes.`;
export const backgroundRunCopy = (handle: string) =>
  `${handle} is running in the background. You'll be notified when it finishes.`;

/**
 * A refusal (an error with no run started) goes back as an error result, so
 * the model and the app both see a failed call. A run that started and
 * failed is a delivered report and stays a plain result.
 */
export function spawnToolResult(
  result: SpawnResult | InvalidArgumentsResult,
): SpawnResult | { isError: true; output: SpawnResult | InvalidArgumentsResult } {
  // An argument the coordinator refused reads exactly like the executor's parse refusal.
  if ("issues" in result) return { isError: true, output: result };
  if (result.status !== "error" || result.execution !== undefined) return result;
  return { isError: true, output: result };
}

export function renderSpawnOutput(value: JsonValue): string {
  if (isInvalidArguments(value)) {
    return renderInvalidArguments("spawn", (value as unknown as InvalidArgumentsResult).issues);
  }
  if (!isSpawnResult(value)) return renderRefusal(value);
  const result = value as SpawnResult;
  if (result.status === "background") {
    // A spawned run carries its execution; a queued thread_message has none.
    if (result.execution !== undefined) return backgroundRunCopy(result.handle);
    return result.notifiesCaller ? queuedNotifyCopy(result.handle) : queuedNoReplyCopy;
  }
  const report = result.report;
  if (!report)
    return renderRefusal(result.status === "error" ? (result.error as JsonValue) : value);
  return [
    `Subagent ${report.handle}`,
    renderReportBlock({
      outcome: result.outcome ?? "failed",
      source: report.source,
      reason: result.status === "error" ? (result.reason ?? null) : null,
      partial: false,
      content: reportContent(report.summary, report.payload, report.artifacts),
    }),
  ].join("\n");
}

function isInvalidArguments(value: JsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.error === "invalid_arguments" &&
    Array.isArray(value.issues)
  );
}

function isSpawnResult(value: JsonValue): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return value.status === "completed" || value.status === "error" || value.status === "background";
}
