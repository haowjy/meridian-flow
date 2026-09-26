/** Exact, lineage-authorized saved execution report read. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import { sameLineage } from "../../threads/domain/lineage.js";
import { parseThreadRef } from "../../threads/domain/thread-ref.js";
import type { ThreadRepositories } from "../../threads/ports/repositories.js";

export async function readThreadReport(input: {
  callerThreadId: ThreadId;
  ref: string;
  run?: number;
  repos: Pick<ThreadRepositories, "threads" | "executionReports" | "readSnapshot">;
}): Promise<ThreadReportResult> {
  return input.repos.readSnapshot(async () => {
    const caller = await input.repos.threads.findById(input.callerThreadId);
    const ref = parseThreadRef(input.ref);
    if (
      !caller ||
      ref?.kind !== "subagent" ||
      (input.run !== undefined && (!Number.isSafeInteger(input.run) || input.run < 1))
    ) {
      throw new Error("Thread report is not authorized");
    }
    const child = await input.repos.threads.findLiveByProjectRef(caller.projectId, input.ref);
    if (child?.kind !== "subagent" || child.userId !== caller.userId || !sameLineage(caller, child))
      throw new Error("Thread report is not authorized");
    const reports = await input.repos.executionReports.listFinishedByChild(child.id as ThreadId);
    const run = input.run ?? reports.length;
    const record = reports[run - 1];
    if (!record || record.outcome === null || record.source === null || record.summary === null)
      return { ref: input.ref, status: "unavailable" };
    return {
      ref: input.ref,
      run,
      outcome: record.outcome,
      source: record.source,
      summary: record.summary,
      ...(record.payload !== undefined ? { payload: record.payload } : {}),
      ...(record.artifacts !== null ? { artifacts: record.artifacts } : {}),
      partial: record.outcome !== "succeeded",
      reason: record.reason,
    };
  });
}
