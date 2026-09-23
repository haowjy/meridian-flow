/** Exact, lineage-authorized saved execution report read. */

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
}): Promise<ThreadReportResult> {
  return input.repos.readSnapshot(async () => {
    const caller = await input.repos.threads.findById(input.callerThreadId);
    const ref = parseThreadRef(input.ref);
    if (
      !caller ||
      !ref ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.execution,
      )
    ) {
      throw new Error("Thread report is not authorized");
    }
    const child = await input.repos.threads.findLiveByProjectRef(caller.projectId, input.ref);
    if (!child || child.userId !== caller.userId || !sameLineage(caller, child))
      throw new Error("Thread report is not authorized");
    const record = await input.repos.executionReports.findByExecution(
      child.id as ThreadId,
      input.execution as TurnId,
    );
    if (!record || record.outcome === null || record.source === null || record.summary === null) {
      return {
        ref: input.ref,
        execution: input.execution as TurnId,
        status: record ? "not_ready" : "unavailable",
      };
    }
    return {
      ref: input.ref,
      execution: input.execution as TurnId,
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
