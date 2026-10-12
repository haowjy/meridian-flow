/** Exact, lineage-authorized saved execution report read. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import type { ThreadRepositories } from "../../threads/ports/repositories.js";
import { resolveReadableThread, threadReadError } from "./resolve-readable-thread.js";

export async function readThreadReport(input: {
  callerThreadId: ThreadId;
  ref: string;
  run?: number;
  repos: Pick<ThreadRepositories, "threads" | "turns" | "executionReports" | "readSnapshot">;
}): Promise<ThreadReportResult> {
  return input.repos.readSnapshot(async () => {
    const caller = await input.repos.threads.findById(input.callerThreadId);
    if (!caller) return threadReadError("thread_not_found", "Thread not found");
    const resolved = await resolveReadableThread({
      caller,
      ref: input.ref,
      threads: input.repos.threads,
      turns: input.repos.turns,
    });
    if (!resolved.ok) return resolved;
    const child = resolved.target;
    if (child.kind !== "subagent")
      return threadReadError("thread_not_found", "A report requires a subagent thread");
    if (input.run !== undefined && (!Number.isSafeInteger(input.run) || input.run < 1))
      return threadReadError("invalid_run", "Run must be a positive integer");
    const reports = await input.repos.executionReports.listFinishedByChild(child.id as ThreadId);
    const run = input.run ?? reports.length;
    const record = reports[run - 1];
    if (!record || record.outcome === null || record.source === null || record.summary === null)
      return { childThreadId: child.id as ThreadId, ref: input.ref, status: "unavailable" };
    return {
      childThreadId: child.id as ThreadId,
      ref: input.ref,
      run,
      outcome: record.outcome,
      deliveryMode: record.deliveryMode,
      source: record.source,
      summary: record.summary,
      ...(record.payload !== undefined ? { payload: record.payload } : {}),
      ...(record.artifacts !== null ? { artifacts: record.artifacts } : {}),
      partial: record.outcome !== "succeeded",
      reason: record.reason,
    };
  });
}
