/** Direct tool result derived only from an immutable terminal execution report. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { AgentReport, SavedExecutionReport, SpawnResult } from "@meridian/contracts/spawn";

export function savedReportToSpawnResult(report: SavedExecutionReport): SpawnResult {
  if (!report.outcome || report.summary === null || !report.source) {
    throw new Error("Execution report is not terminal");
  }
  const content: AgentReport = {
    handle: report.handle,
    threadId: report.childThreadId,
    summary: report.summary,
    ...(report.payload !== null ? { payload: report.payload } : {}),
    ...(report.artifacts !== null ? { artifacts: report.artifacts } : {}),
    costMillicredits: report.costMillicredits ?? 0,
  };
  if (report.outcome === "succeeded") {
    return {
      status: "completed",
      execution: report.assistantTurnId,
      outcome: "succeeded",
      report: content,
    };
  }
  return {
    status: "error",
    error: meridianErrorFromSystem(
      report.outcome === "cancelled" ? "spawn_cancelled" : "spawn_failed",
      report.outcome === "cancelled" ? "Child run was cancelled" : "Child run failed",
    ),
    execution: report.assistantTurnId,
    outcome: report.outcome,
    report: content,
    partial: true,
    reason: report.reason,
  };
}
