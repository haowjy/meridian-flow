/**
 * DELETE /api/threads/[threadId]: soft-deletes an owned thread (idempotent), then ends its run
 * and subagent subtree. Depends on the auth gate, thread ownership, thread repositories, and the
 * turn runner.
 */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { deleteOwnedThreadToTrash } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { threadRepos, projectRepo, workContextNotices } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  const thread = await deleteOwnedThreadToTrash(
    {
      repos: threadRepos,
      projects: projectRepo,
      workContextNotices,
      workAuthorityResolver: app.workAuthorityResolver,
      works: app.workRepo,
      cancelAsks: (id) => app.asks.cancelForThreadLifecycle(id),
    },
    threadId,
    userId,
  );
  await app.stopThreads([thread.id]);
  setResponseStatus(event, 204);
});
