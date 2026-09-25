/** Read one exact saved child execution report for its authorized parent thread. */
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { readThreadReport } from "../../../../../../domains/runtime/spawn/read-thread-report.js";
import { requireThreadOwner } from "../../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event): Promise<ThreadReportResult> => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const childThreadId = getRouterParam(event, "childThreadId") ?? "";
  const execution = getRouterParam(event, "execution") ?? "";
  const parent = await requireThreadOwner(
    { threads: app.repos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  const child = await app.repos.threads.findById(childThreadId);
  if (!child?.ref) throw new Error("Thread report is not authorized");
  // The card names its exact execution; the shared reader addresses finished runs by position.
  const reports = await app.repos.executionReports.listFinishedByChild(child.id);
  const run = reports.findIndex((report) => report.assistantTurnId === execution) + 1;
  if (run === 0) return { ref: child.ref, status: "unavailable" };
  return readThreadReport({ callerThreadId: parent.id, ref: child.ref, run, repos: app.repos });
});
