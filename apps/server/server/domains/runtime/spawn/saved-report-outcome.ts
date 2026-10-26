/** Direct tool result derived only from an immutable terminal execution report. */
import { meridianErrorFromSystem } from "@meridian/contracts/errors";
import type { AgentReport, SavedExecutionReport, SpawnResult } from "@meridian/contracts/spawn";
import type { StoredAsk } from "../../threads/index.js";

export function savedReportToSpawnResult(
  report: SavedExecutionReport,
  ask?: StoredAsk | null,
): SpawnResult {
  if (report.outcome === null) {
    throw new Error("Execution report is not terminal");
  }
  const content: AgentReport = {
    handle: report.handle,
    threadId: report.childThreadId,
    source: report.source,
    summary: report.summary,
    ...(report.payload !== undefined ? { payload: report.payload } : {}),
    ...(report.artifacts !== null ? { artifacts: report.artifacts } : {}),
  };
  if (report.outcome === "asked") {
    if (ask?.kind !== "question") throw new Error("Asked report has no question");
    const payload = ask.payload as import("@meridian/contracts/threads").QuestionAskPayload;
    return {
      status: "asked",
      execution: report.executionTurnId,
      outcome: "asked",
      childThreadId: report.childThreadId,
      handle: report.handle,
      ask: {
        id: ask.id,
        question: payload.question,
        options: payload.options.map((option) => option.label),
        ...(payload.recommended ? { recommended: payload.recommended } : {}),
      },
    };
  }
  if (report.outcome === "succeeded") {
    return {
      status: "completed",
      execution: report.executionTurnId,
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
    execution: report.executionTurnId,
    outcome: report.outcome,
    report: content,
    partial: true,
    reason: report.reason,
  };
}
