/** Direct tool result derived only from an immutable terminal execution report. */
import { meridianErrorFromSystem } from "@meridian/contracts/errors";
import type { AgentReport, SavedExecutionReport, SpawnResult } from "@meridian/contracts/spawn";
import type { AskRepository, StoredAsk } from "../../threads/index.js";

/**
 * The outcome every reader shows: an asked report whose question's continuation was
 * cancelled (by a lineage cancellation, or withdrawn) ended the invocation cancelled.
 */
export function reportOutcome(
  report: Pick<SavedExecutionReport, "outcome">,
  question: Pick<StoredAsk, "continuation"> | null | undefined,
): SavedExecutionReport["outcome"] {
  return report.outcome === "asked" && question?.continuation === "cancelled"
    ? "cancelled"
    : report.outcome;
}

/** `reports` with each outcome as `reportOutcome` reads it, in one ask query. */
export async function withReportOutcomes(
  asks: Pick<AskRepository, "listByTurnIds">,
  reports: SavedExecutionReport[],
): Promise<SavedExecutionReport[]> {
  const askedTurns = reports.flatMap((report) =>
    report.outcome === "asked" && report.terminalTurnId ? [report.terminalTurnId] : [],
  );
  if (askedTurns.length === 0) return reports;
  const questions = new Map(
    (await asks.listByTurnIds(askedTurns))
      .filter((ask) => ask.kind === "question")
      .map((ask) => [ask.askingTurnId as string, ask]),
  );
  return reports.map((report) => {
    const outcome = reportOutcome(
      report,
      report.terminalTurnId ? questions.get(report.terminalTurnId) : null,
    );
    return outcome === report.outcome ? report : ({ ...report, outcome } as SavedExecutionReport);
  });
}

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
