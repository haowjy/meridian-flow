/** Exact, lineage-authorized saved execution report read. */

import { parseRequestId } from "@meridian/contracts/request-id";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import { sameLineage } from "../../threads/domain/lineage.js";
import { parseThreadRef } from "../../threads/domain/thread-ref.js";
import type { ThreadRepositories } from "../../threads/ports/repositories.js";

export async function readThreadReport(input: {
  callerThreadId: ThreadId;
  ref: string;
  execution: string;
  repos: Pick<ThreadRepositories, "threads" | "executionReports" | "readSnapshot">;
  runningTurn: { readRunningTurnId(threadId: ThreadId): Promise<TurnId | null> };
}): Promise<ThreadReportResult> {
  return input.repos.readSnapshot(async () => {
    const caller = await input.repos.threads.findById(input.callerThreadId);
    const ref = parseThreadRef(input.ref);
    const execution = parseRequestId(input.execution);
    if (!caller || ref?.kind !== "subagent" || !execution) {
      throw new Error("Thread report is not authorized");
    }
    const child = await input.repos.threads.findLiveByProjectRef(caller.projectId, input.ref);
    if (child?.kind !== "subagent" || child.userId !== caller.userId || !sameLineage(caller, child))
      throw new Error("Thread report is not authorized");
    const record = await input.repos.executionReports.findByExecution(
      child.id as ThreadId,
      execution as TurnId,
    );
    if (!record || record.outcome === null || record.source === null || record.summary === null) {
      const running = record
        ? await input.runningTurn.readRunningTurnId(child.id as ThreadId)
        : null;
      return {
        ref: input.ref,
        execution: execution as TurnId,
        status: record && running === execution ? "not_ready" : "unavailable",
      };
    }
    return {
      ref: input.ref,
      execution: execution as TurnId,
      outcome: record.outcome,
      source: record.source,
      summary: record.summary,
      ...(record.payload !== null ? { payload: record.payload } : {}),
      ...(record.artifacts !== null ? { artifacts: record.artifacts } : {}),
      partial: record.outcome !== "succeeded",
      reason: record.reason,
    };
  });
}
