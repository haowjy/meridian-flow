/** The model's `thread_report`: the child's latest finished report, and whether it is running again. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { ModelThreadReportResult } from "@meridian/contracts/spawn";
import type { ThreadRepositories } from "../../threads/ports/repositories.js";
import { readThreadReport } from "./read-thread-report.js";

export const runningAgainCopy = (ref: string) =>
  `${ref} is running again; this report is from its previous run. You'll be notified when it finishes.`;
export const reportUnavailableCopy = (ref: string) =>
  `${ref} has no finished report yet. You'll be notified when it finishes; don't call \`thread_report\` again until then.`;

export async function readModelThreadReport(input: {
  callerThreadId: ThreadId;
  ref: string;
  repos: Pick<ThreadRepositories, "threads" | "executionReports" | "readSnapshot">;
}): Promise<ModelThreadReportResult> {
  const report = await readThreadReport(input);
  if ("ok" in report) return report;
  const child = await input.repos.threads.findById(report.childThreadId);
  const ref = child?.ref ?? report.ref;
  if ("status" in report)
    return { ref, status: report.status, message: reportUnavailableCopy(ref) };
  const [latest] = await input.repos.executionReports.listLatestByChildren([report.childThreadId]);
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
    ...(running ? { running: true as const, message: runningAgainCopy(ref) } : {}),
  };
}
