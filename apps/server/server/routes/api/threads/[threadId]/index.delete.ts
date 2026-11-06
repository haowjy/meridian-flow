/**
 * DELETE /api/threads/[threadId]: soft-deletes an owned thread (idempotent) and, in the same
 * transaction, ends its run and subagent subtree. Depends on the auth gate, thread ownership,
 * thread repositories, and the turn runner.
 */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { deleteOwnedThreadToTrash } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { threadRepos, projectRepo, workContextNotices } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  await deleteOwnedThreadToTrash(
    {
      repos: threadRepos,
      projects: projectRepo,
      workContextNotices,
      workAuthorityResolver: app.workAuthorityResolver,
      works: app.workRepo,
      stopThreads: app.stopThreads,
    },
    threadId,
    userId,
  );
  setResponseStatus(event, 204);
});
