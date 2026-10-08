/** Read one exact saved child execution report for its authorized parent thread. */
import type { ThreadReportResult } from "@meridian/contracts/spawn";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { readThreadReport } from "../../../../../../domains/runtime/spawn/read-thread-report.js";
import { resolveReadableThread } from "../../../../../../domains/runtime/spawn/resolve-readable-thread.js";
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
  if (!child?.ref) throw createError({ statusCode: 404, message: "Thread not found" });
  const readable = await resolveReadableThread({
    caller: parent,
    ref: child.ref,
    threads: app.repos.threads,
    turns: app.repos.turns,
  });
  if (!readable.ok)
    throw createError({
      statusCode: readable.error.code === "thread_not_found" ? 404 : 403,
      message: readable.error.message,
      data: readable.error,
    });
  if (readable.target.id !== child.id)
    throw createError({ statusCode: 404, message: "Thread not found" });
  // The card names its exact execution; the shared reader addresses finished runs by position.
  const reports = await app.repos.executionReports.listFinishedByChild(child.id);
  const run = reports.findIndex((report) => report.executionTurnId === execution) + 1;
  if (run === 0) return { childThreadId: child.id, ref: child.ref, status: "not_ready" };
  const result = await readThreadReport({
    callerThreadId: parent.id,
    ref: child.ref,
    run,
    repos: app.repos,
  });
  if ("error" in result)
    throw createError({
      statusCode: result.error.code === "thread_not_found" ? 404 : 403,
      message: result.error.message,
      data: result.error,
    });
  return result;
});
