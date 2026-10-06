/** The model's `thread_report`: the child's latest finished report, and whether it is running again. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { ModelThreadReportResult } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";
import type { ThreadRepositories } from "../../threads/ports/repositories.js";
import { renderRefusal } from "../tools/refusal.js";
import { renderReportBlock, reportContent } from "./history-result.js";
import { readThreadReport } from "./read-thread-report.js";

const runningAgainCopy = (ref: string, notified = true) =>
  notified
    ? `${ref} is running again; this report is from its previous run. You'll be notified when it finishes.`
    : `${ref} is running again; this report is from its previous run. You won't be notified when it finishes.`;
const reportUnavailableCopy = (ref: string, notified = true) =>
  notified
    ? `${ref} has no finished report yet. You'll be notified when it finishes; don't call \`thread_report\` again until then.`
    : `${ref} has no finished report yet. You won't be notified when it finishes.`;

export async function readModelThreadReport(input: {
  callerThreadId: ThreadId;
  ref: string;
  repos: Pick<ThreadRepositories, "threads" | "executionReports" | "readSnapshot">;
}): Promise<ModelThreadReportResult> {
  const report = await readThreadReport(input);
  if ("ok" in report) return report;
  const child = await input.repos.threads.findById(report.childThreadId);
  const ref = child?.ref ?? report.ref;
  const [latest] = await input.repos.executionReports.listLatestByChildren([report.childThreadId]);
  // Only a run that reports back to this caller earns the "you'll be notified" promise.
  const notified =
    latest !== undefined &&
    latest.deliveryMode === "background_notification" &&
    latest.callerThreadId === input.callerThreadId;
  if ("status" in report)
    return { ref, status: report.status, message: reportUnavailableCopy(ref, notified) };
  const running = latest !== undefined && latest.terminalAt === null;
  return {
    ref,
    outcome: report.outcome,
    summary: report.summary,
    ...(report.payload !== undefined ? { payload: report.payload } : {}),
    ...(report.artifacts?.length ? { artifacts: report.artifacts } : {}),
    ...(report.reason !== null ? { reason: report.reason } : {}),
    ...(report.partial ? { partial: true as const } : {}),
    ...(report.source !== "return_result" ? { source: report.source } : {}),
    ...(running ? { running: true as const, message: runningAgainCopy(ref, notified) } : {}),
  };
}

/**
 * The model's text for a `thread_report` result (D8): the report as history
 * shows it, then the running or unavailable line. The typed result stays
 * beside it for the app and code mode.
 */
export function renderThreadReportOutput(value: JsonValue): string {
  const result = value as ModelThreadReportResult | null;
  if (!result || typeof result !== "object" || !("ref" in result)) return renderRefusal(value);
  if ("status" in result) return result.message ?? reportUnavailableCopy(result.ref);
  return [
    renderReportBlock({
      outcome: result.outcome,
      source: result.source ?? "return_result",
      reason: result.reason ?? null,
      partial: result.partial === true,
      content: reportContent(result.summary, result.payload, result.artifacts),
    }),
    ...(result.message ? [result.message] : []),
  ].join("\n\n");
}
